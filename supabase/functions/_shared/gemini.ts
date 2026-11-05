// Gemini REST 呼叫（Deno 與 Node 都能跑：只用 fetch）。
// 錯誤分三類：暫時性（429 速率／5xx，自動重試）、額度或帳務（停下來通知甲乙方，補足後續跑）、其他（該頁失敗）。

export type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

export class GeminiQuotaError extends Error {}   // 額度不足、帳單問題 → 整個佇列暫停
export class GeminiError extends Error {}

export interface GeminiResult<T> {
  json: T;
  inputTokens: number;
  outputTokens: number; // 含思考 token（同樣按輸出計費）
}

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export function imagePart(bytes: Uint8Array, mime = "image/jpeg"): Part {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { inline_data: { mime_type: mime, data: btoa(bin) } };
}

function isQuotaMessage(msg: string): boolean {
  return /billing|quota|exceeded your current|prepay|credit|RESOURCE_EXHAUSTED.*(per day|daily)/i.test(msg);
}

/** 思考程度：Gemini 3.8 Flash 支援 low／medium／high（預設 high；不支援 minimal）。null＝用模型預設 */
export type ThinkingLevel = "low" | "medium" | "high" | null;
let thinkingLevel: ThinkingLevel = null;
export function setThinkingLevel(level: ThinkingLevel) { thinkingLevel = level; }
const thinkingConfig = () => (thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {});

export async function generateJson<T>(
  apiKey: string, model: string, parts: Part[], schema: unknown,
  opts: { retries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<GeminiResult<T>> {
  const retries = opts.retries ?? 4;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(`${BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, ...thinkingConfig() },
      }),
    });
    const body = await resp.text();
    if (resp.ok) {
      const data = JSON.parse(body);
      const cand = data.candidates?.[0];
      const text = cand?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
      if (!text) throw new GeminiError(`沒有回傳內容（finishReason=${cand?.finishReason ?? "?"}）`);
      const u = data.usageMetadata ?? {};
      return {
        json: JSON.parse(text) as T,
        inputTokens: u.promptTokenCount ?? 0,
        outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      };
    }
    lastErr = `HTTP ${resp.status}: ${body.slice(0, 300)}`;
    if ((resp.status === 429 || resp.status === 403 || resp.status === 400) && isQuotaMessage(body)) {
      throw new GeminiQuotaError(lastErr);
    }
    if (resp.status === 429 || resp.status >= 500) {
      if (attempt < retries) await sleep(5000 * (attempt + 1));
      continue;
    }
    throw new GeminiError(lastErr);
  }
  throw new GeminiError(`重試 ${retries} 次仍失敗：${lastErr}`);
}

// ---------- 批次模式（Batch API，費用 5 折，通常幾分鐘到 1 小時、最長 24 小時）----------
// 2026-10-16 實測：批次請求用 responseJsonSchema 會回「invalid argument」（簡單的 schema 能過但不會強制型態），
// 要改用舊版 responseSchema（OpenAPI 子集：nullable、不支援 additionalProperties）才會照格式回傳。

/** JSON Schema → Gemini responseSchema（OpenAPI 子集） */
export function toOpenApiSchema(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(toOpenApiSchema);
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    const any = o.anyOf as Record<string, unknown>[] | undefined;
    if (any?.length === 2 && any[1].type === "null") return { ...(toOpenApiSchema(any[0]) as object), nullable: true };
    return Object.fromEntries(Object.entries(o).filter(([k]) => k !== "additionalProperties").map(([k, v]) => [k, toOpenApiSchema(v)]));
  }
  return x;
}

export interface BatchItem { key: string; parts: Part[]; schema: unknown }

export async function createBatch(apiKey: string, model: string, name: string, items: BatchItem[]): Promise<string> {
  const requests = items.map((it) => ({
    request: {
      contents: [{ role: "user", parts: it.parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: toOpenApiSchema(it.schema), ...thinkingConfig() },
    },
    metadata: { key: it.key },
  }));
  const resp = await fetch(`${BASE}/${model}:batchGenerateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ batch: { display_name: name, input_config: { requests: { requests } } } }),
  });
  const body = await resp.text();
  if (!resp.ok) {
    const msg = `HTTP ${resp.status}: ${body.slice(0, 300)}`;
    if (isQuotaMessage(body)) throw new GeminiQuotaError(msg);
    throw new GeminiError(msg);
  }
  return JSON.parse(body).name as string;
}

export interface BatchResult<T> { key: string; json?: T; error?: string; inputTokens: number; outputTokens: number }
export interface BatchStatus<T> { state: "pending" | "running" | "succeeded" | "failed"; results?: BatchResult<T>[]; error?: string }

export async function getBatch<T>(apiKey: string, name: string): Promise<BatchStatus<T>> {
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}`, { headers: { "x-goog-api-key": apiKey } });
  const body = await resp.text();
  if (!resp.ok) throw new GeminiError(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
  const d = JSON.parse(body);
  const st: string = d.metadata?.state ?? "";
  if (st === "BATCH_STATE_PENDING") return { state: "pending" };
  if (st === "BATCH_STATE_RUNNING") return { state: "running" };
  if (st !== "BATCH_STATE_SUCCEEDED") return { state: "failed", error: `${st} ${JSON.stringify(d.error ?? "").slice(0, 200)}` };
  // deno-lint-ignore no-explicit-any
  const items: any[] = d.response?.inlinedResponses?.inlinedResponses ?? [];
  return {
    state: "succeeded",
    results: items.map((it) => {
      const key = it.metadata?.key as string;
      if (it.error) return { key, error: JSON.stringify(it.error).slice(0, 300), inputTokens: 0, outputTokens: 0 };
      const r = it.response ?? {};
      const u = r.usageMetadata ?? {};
      const text = r.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
      const tokens = { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
      try { return { key, json: JSON.parse(text) as T, ...tokens }; }
      catch { return { key, error: `回傳內容不是 JSON（finishReason=${r.candidates?.[0]?.finishReason ?? "?"}）`, ...tokens }; }
    }),
  };
}
