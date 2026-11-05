// 辨識佇列：每分鐘由排程（pg_cron）呼叫一次，上傳完成時也會立刻呼叫一次。
//
// 兩種模式（系統設定 → 辨識模式，存在 settings.recognition_mode）：
//   batch（預設）：待處理頁面打包送 Gemini Batch API（費用 5 折，通常幾分鐘到 1 小時、最長 24 小時）。
//                  第一輪收款辨識；沒有收款的頁面（status=followup）再送第二輪批次，同時送透字判斷與轉錄，
//                  透字頁的轉錄結果丟掉。批次失敗兩次的頁面、第二輪失敗的頁面改用即時處理。
//   realtime   ：每次在時間預算內反覆「領取一批頁面 → 並行辨識 → 寫回」，掃完幾分鐘內完成，費用是批次的兩倍。
// 最後把全部頁面都辨識完的上傳檔整理成收款與其他單據紀錄。
// AI 額度不足或帳務錯誤 → 暫停整個佇列並通知；之後每次排程先試一頁，成功就自動續跑（附件一項目 2「失敗重送」）。

import { type BatchResult, createBatch, GeminiQuotaError, getBatch } from "../_shared/gemini.ts";
import {
  assembleFollowup, completePage, findContinuationGroups, followupItems, mergeStatement, mirrorPath, needsFollowUp, processPage, receiptParts,
  type PageResult,
} from "../_shared/pipeline.ts";
import { RECEIPT_PROMPT_VERSION, RECEIPT_SCHEMA, type OtherPage, type ReceiptPage } from "../_shared/prompts.ts";
import { finalizeUpload, type FinalPage } from "../_shared/finalize.ts";
import { json, notify, resolve, sendPendingNotifications, serviceClient } from "../_shared/db.ts";

const CONCURRENCY = Number(Deno.env.get("AI_CONCURRENCY") ?? 8);
const BUDGET_MS = 110_000;          // Edge Function 時間上限內留餘裕
const MAX_ATTEMPTS = 3;             // 第 3 次一律改用即時處理，再失敗就標記辨識失敗（進人工複核）
const BATCH_MAX_BYTES = 14_000_000; // Gemini 批次直接夾帶內容上限 20MB（base64 會膨脹約 1.33 倍）
const BATCH_MAX_PAGES = 60;
const BATCH_STUCK_HOURS = 25;       // 超過就當作失敗重送（Gemini 批次最長 24 小時）

type PageRef = { id: string; image_path: string; attempts: number; result?: PageResult | null };

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return json({ error: "unauthorized" }, 401);
  // 通過驗證後才把錯誤內容回傳（排程呼叫的回應會留在 net._http_response，方便查問題）
  try { return await run(req); } catch (e) { console.error(e); const err = e as Error; return json({ error: String(err?.message ?? e), stack: String(err?.stack ?? "").slice(0, 800) }, 500); }
});

async function run(_req: Request): Promise<Response> {
  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);
  const sb = serviceClient();
  const apiKey = Deno.env.get("GEMINI_API_KEY")!;
  const { data: settings } = await sb.from("settings").select("*").single();
  const model: string = settings.ai_model;
  const mode: "batch" | "realtime" = settings.recognition_mode;
  let paused: boolean = settings.ai_paused;
  const stats = { processed: 0, submitted: 0, batchesDone: 0, finalized: 0 };

  async function loadImage(path: string): Promise<Uint8Array> {
    const { data, error } = await sb.storage.from("scans").download(path);
    if (error) throw new Error(`讀不到影像 ${path}：${error.message}`);
    return new Uint8Array(await data.arrayBuffer());
  }

  async function pause(e: Error) {
    if (paused) return;
    paused = true;
    await sb.from("settings").update({ ai_paused: true, ai_pause_reason: String(e.message).slice(0, 500), ai_paused_at: new Date().toISOString() }).eq("id", true);
    await notify(sb, "ai_quota", "Google Gemini 額度不足或帳務錯誤，AI 辨識已暫停。請到 Google AI Studio 確認付款與額度，補足後系統會自動續跑，不需要重新掃描。");
  }

  // 翻轉圖只在辨識時用到，這一頁結束（完成或確定失敗）就刪掉，長期只保存原圖
  async function dropMirror(p: PageRef) {
    await sb.storage.from("scans").remove([mirrorPath(p.image_path)]);
    await sb.from("pages").update({ mirror_deleted_at: new Date().toISOString() }).eq("id", p.id);
  }

  async function saveDone(p: PageRef, r: Awaited<ReturnType<typeof processPage>>) {
    await sb.from("pages").update({
      status: "done", result: r, page_type: r.receipt.page_type, model, prompt_version: RECEIPT_PROMPT_VERSION,
      input_tokens: r.inputTokens, output_tokens: r.outputTokens, processed_at: new Date().toISOString(),
      error: null, lease_until: null, batch_name: null,
    }).eq("id", p.id);
    await dropMirror(p);
    stats.processed++;
  }

  async function saveError(p: PageRef, e: unknown) {
    if (e instanceof GeminiQuotaError) {
      // 退回待處理，不算失敗次數
      await sb.from("pages").update({ status: "pending", attempts: Math.max(0, p.attempts - 1), lease_until: null, batch_name: null }).eq("id", p.id);
      await pause(e);
      return;
    }
    const failed = p.attempts >= MAX_ATTEMPTS;
    await sb.from("pages").update({ status: failed ? "failed" : "pending", error: String(e).slice(0, 500), lease_until: null, batch_name: null,
      ...(failed ? { processed_at: new Date().toISOString() } : {}) }).eq("id", p.id);
    if (failed) await dropMirror(p);
  }

  // 即時處理一頁；回傳 false 代表碰到額度問題，要停下來
  async function runPage(p: PageRef): Promise<boolean> {
    try {
      await saveDone(p, await processPage(apiKey, model, await loadImage(p.image_path), () => loadImage(mirrorPath(p.image_path))));
      return true;
    } catch (e) {
      await saveError(p, e);
      return !(e instanceof GeminiQuotaError);
    }
  }

  async function pool<T>(items: T[], fn: (x: T) => Promise<unknown>) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length && !paused) await fn(items[i++]);
    }));
  }

  // ===== 暫停中：先試一頁 =====
  if (paused) {
    const { data } = await sb.rpc("claim_pages", { p_limit: 1, p_lease_seconds: 300 });
    if (data?.length && await runPage(data[0])) {
      paused = false;
      await sb.from("settings").update({ ai_paused: false, ai_pause_reason: null, ai_paused_at: null }).eq("id", true);
      await resolve(sb, "ai_quota");
    }
  }

  // 第二輪結束（或失敗）時，用即時呼叫補完這一頁
  async function completeRealtime(p: PageRef) {
    try {
      const receipt = p.result!.receipt;
      await saveDone(p, await completePage(apiKey, model, await loadImage(p.image_path), await loadImage(mirrorPath(p.image_path)),
        receipt, { inputTokens: p.result!.inputTokens, outputTokens: p.result!.outputTokens }));
    } catch (e) {
      if (e instanceof GeminiQuotaError) {
        await sb.from("pages").update({ status: "followup", lease_until: null, batch_name: null }).eq("id", p.id);
        await pause(e);
      } else {
        await saveError(p, e);
      }
    }
  }

  // ===== 收回已完成的批次（模式切換後，送出去的批次照樣收回）=====
  const { data: open } = await sb.from("ai_batches").select("*").in("state", ["pending", "running"]).order("created_at");
  for (const b of open ?? []) {
    if (paused || left() < 40_000) break;
    // deno-lint-ignore no-explicit-any
    const st = await getBatch<any>(apiKey, b.name).catch((e) => ({ state: "running" as const, error: String(e) }));
    const stuck = Date.now() - new Date(b.created_at).getTime() > BATCH_STUCK_HOURS * 3600_000;
    if ((st.state === "pending" || st.state === "running") && !stuck) {
      if (st.state !== b.state) await sb.from("ai_batches").update({ state: st.state }).eq("name", b.name);
      continue;
    }
    const { data: pages } = await sb.from("pages").select("id, image_path, attempts, result").eq("batch_name", b.name).eq("status", "submitted");
    const byId = new Map((pages ?? []).map((p) => [p.id as string, p as PageRef]));
    const results = st.state === "succeeded" && "results" in st ? st.results ?? [] : [];

    if (b.kind === "followup") {
      // 第二輪：每頁兩個結果（透字判斷、轉錄）
      const grouped = new Map<string, { mirror?: typeof results[number]; other?: typeof results[number] }>();
      for (const r of results) {
        const [id, part] = r.key.split("|");
        grouped.set(id, { ...grouped.get(id), [part]: r });
      }
      await pool([...byId.values()], async (p) => {
        const g = grouped.get(p.id);
        const page = g && p.result
          ? assembleFollowup(p.result.receipt, p.result, g.mirror, g.other as BatchResult<OtherPage> | undefined) : null;
        if (page) await saveDone(p, page);
        else if (p.result) await completeRealtime(p);       // 第二輪失敗或缺結果 → 即時補完
        else await saveError(p, new Error("找不到第一輪的收款辨識結果"));
      });
    } else {
      // 第一輪：收款辨識
      await pool(results, async (r) => {
        const p = byId.get(r.key);
        if (!p) return;
        byId.delete(r.key);
        if (!r.json) return saveError(p, new Error(`批次辨識失敗：${r.error}`));
        const receipt = r.json as ReceiptPage;
        const base: PageResult = { receipt, mirror: null, other: null, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
        try {
          if (!needsFollowUp(receipt)) await saveDone(p, base);          // 有收款：完成
          else if (mode === "batch") {                                    // 沒收款：等第二輪批次
            await sb.from("pages").update({ status: "followup", result: base, page_type: receipt.page_type, batch_name: null, lease_until: null }).eq("id", p.id);
          } else await completeRealtime({ ...p, result: base });          // 已切成即時模式：直接補完
        } catch (e) {
          await saveError(p, e);
        }
      });
      // 批次失敗、卡住，或結果裡缺的頁面 → 退回待處理重送
      for (const p of byId.values()) await saveError(p, new Error(st.state === "succeeded" ? "批次結果缺少這一頁" : `批次失敗：${st.error ?? "逾時"}`));
    }
    await sb.from("ai_batches").update({ state: st.state === "succeeded" ? "succeeded" : "failed", error: st.error ?? null, finished_at: new Date().toISOString() }).eq("name", b.name);
    stats.batchesDone++;
  }

  // ===== 處理待辨識頁面 =====
  if (mode === "realtime") {
    while (!paused && left() > 30_000) {
      const { data: fu } = await sb.rpc("claim_followups", { p_limit: CONCURRENCY, p_lease_seconds: 240 });
      if (!fu?.length) break;
      await Promise.all(fu.map((p: PageRef) => completeRealtime(p)));
    }
    while (!paused && left() > 30_000) {
      const { data: batch, error } = await sb.rpc("claim_pages", { p_limit: CONCURRENCY, p_lease_seconds: 240 });
      if (error) throw error;
      if (!batch?.length) break;
      await Promise.all(batch.map(runPage));
    }
  } else {
    while (!paused && left() > 40_000) {
      const { data: claimed, error } = await sb.rpc("claim_pages", { p_limit: BATCH_MAX_PAGES, p_lease_seconds: 300 });
      if (error) throw error;
      if (!claimed?.length) break;
      // 已經重送過兩次的頁面改用即時處理
      const lastTry = claimed.filter((p: PageRef) => p.attempts >= MAX_ATTEMPTS);
      await pool(lastTry, runPage);
      const items: { key: string; parts: ReturnType<typeof receiptParts>; schema: unknown }[] = [];
      const release: PageRef[] = [];
      let bytes = 0;
      for (const p of claimed.filter((p: PageRef) => p.attempts < MAX_ATTEMPTS)) {
        if (bytes > BATCH_MAX_BYTES) { release.push(p); continue; }
        try {
          const img = await loadImage(p.image_path);
          bytes += img.length;
          items.push({ key: p.id, parts: receiptParts(img), schema: RECEIPT_SCHEMA });
        } catch (e) {
          await saveError(p, e);
        }
      }
      // 超過一批容量的頁面放回去，下一輪再送
      for (const p of release) await sb.from("pages").update({ status: "pending", attempts: p.attempts - 1, lease_until: null }).eq("id", p.id);
      if (!items.length) continue;
      try {
        const name = await createBatch(apiKey, model, `yj-${new Date().toISOString()}`, items);
        const ids = items.map((i) => i.key);
        await sb.from("ai_batches").insert({ name, page_ids: ids });
        await sb.from("pages").update({ status: "submitted", batch_name: name, lease_until: null }).in("id", ids);
        stats.submitted += ids.length;
      } catch (e) {
        for (const id of items.map((i) => i.key)) {
          const p = claimed.find((x: PageRef) => x.id === id)!;
          await saveError(p, e);
        }
        if (e instanceof GeminiQuotaError) break;
      }
    }
    // 第二輪：沒收款的頁面，同時送透字判斷與轉錄
    while (!paused && left() > 40_000) {
      const { data: claimed, error } = await sb.rpc("claim_followups", { p_limit: BATCH_MAX_PAGES / 2, p_lease_seconds: 300 });
      if (error) throw error;
      if (!claimed?.length) break;
      const items: ReturnType<typeof followupItems> = [];
      const sent: PageRef[] = [], release: PageRef[] = [];
      let bytes = 0;
      for (const p of claimed as PageRef[]) {
        if (bytes > BATCH_MAX_BYTES) { release.push(p); continue; }
        try {
          const [jpeg, mirror] = await Promise.all([loadImage(p.image_path), loadImage(mirrorPath(p.image_path))]);
          bytes += jpeg.length * 2 + mirror.length;
          items.push(...followupItems(p.id, jpeg, mirror));
          sent.push(p);
        } catch (e) {
          await saveError(p, e);
        }
      }
      for (const p of release) await sb.from("pages").update({ status: "followup", lease_until: null }).eq("id", p.id);
      if (!items.length) continue;
      try {
        const name = await createBatch(apiKey, model, `yj-followup-${new Date().toISOString()}`, items);
        const ids = sent.map((p) => p.id);
        await sb.from("ai_batches").insert({ name, page_ids: ids, kind: "followup" });
        await sb.from("pages").update({ status: "submitted", batch_name: name, lease_until: null }).in("id", ids);
        stats.submitted += ids.length;
      } catch (e) {
        for (const p of sent) await sb.from("pages").update({ status: "followup", lease_until: null }).eq("id", p.id);
        if (e instanceof GeminiQuotaError) { await pause(e); break; }
        throw e;
      }
    }
  }

  // ===== 整理已全部辨識完的上傳檔 =====
  const { data: uploads } = await sb.from("uploads").select("id, scan_date, file_name").eq("status", "queued");
  for (const u of uploads ?? []) {
    if (left() < 10_000) break;
    const { data: pages } = await sb.from("pages").select("id, page_no, status, error, result, image_path")
      .eq("upload_id", u.id).order("page_no");
    if (!pages?.length || pages.some((p) => p.status !== "done" && p.status !== "failed")) continue;
    try {
      await finalize(u, pages);
      stats.finalized++;
    } catch (e) {
      if (e instanceof GeminiQuotaError) { await pause(e); break; }
      console.error("finalize", u.id, e);
    }
  }

  async function finalize(u: { id: string; scan_date: number; file_name: string }, pages: (FinalPage & { image_path: string })[]) {
    // 跨頁對帳單合併（同一份的幾頁一起送 AI；頁數少，用即時呼叫）
    const done = pages.filter((p) => p.status === "done" && p.result);
    const merged = new Map<string, { pageIds: string[]; receipt: ReceiptPage }>();
    for (const g of findContinuationGroups(done.map((p) => p.result!.receipt))) {
      const gp = g.map((i) => done[i]);
      const r = await mergeStatement(apiKey, model, await Promise.all(gp.map((p) => loadImage(p.image_path))));
      merged.set(gp[0].id, { pageIds: gp.map((p) => p.id), receipt: r.json });
    }
    const cust: { code: string; name: string }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await sb.from("customers").select("code, name").range(from, from + 999);
      cust.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
    const master = new Map(cust.map((c) => [c.code, c.name]));
    const { receipts, others } = finalizeUpload(pages, merged, master);

    // 重跑時先清掉這個上傳檔之前產生的（只會發生在整理到一半中斷時）
    await sb.from("receipts").delete().eq("upload_id", u.id).is("export_id", null).in("status", ["auto", "review"]);
    await sb.from("other_records").delete().eq("upload_id", u.id);
    if (receipts.length) {
      const { error } = await sb.from("receipts").insert(receipts.map((r) => ({
        upload_id: u.id, page_ids: r.page_ids, entry_index: r.entry_index, status: r.status, reasons: r.reasons,
        ai_values: r.values, current_values: r.values, customer_code: r.customer_code, customer_name: r.customer_name,
        amount: r.amount, summary: r.summary, scan_date: u.scan_date,
        released_at: r.status === "auto" ? new Date().toISOString() : null,
      })));
      if (error) throw error;
    }
    if (others.length) {
      const { error } = await sb.from("other_records").insert(others.map((o) => ({
        page_id: o.page_id, upload_id: u.id, scan_date: u.scan_date, source: `${u.file_name} 第 ${o.page_no} 頁`,
        category: o.category, customer_code: o.customer_code, customer_name: o.customer_name, summary: o.summary,
        full_text: o.full_text, printed_total: o.printed_total,
      })));
      if (error) throw error;
    }
    await sb.from("uploads").update({ status: "done", finalized_at: new Date().toISOString() }).eq("id", u.id);
    const auto = receipts.filter((r) => r.status === "auto").length;
    await sb.from("notifications").insert({
      kind: "upload_done", level: "info", resolved_at: new Date().toISOString(), url: receipts.length > auto ? "/review" : "/",
      message: `${u.file_name} 辨識完成：自動放行 ${auto} 筆、待複核 ${receipts.length - auto} 筆、其他單據 ${others.length} 頁`,
    });
  }

  await sendPendingNotifications(sb);
  return json({ mode, paused, ...stats, ms: Date.now() - started });
}
