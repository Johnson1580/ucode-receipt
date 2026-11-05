// 用 22 頁真實樣本驗證雲端辨識流程（同一份 _shared 程式）：
// 收款單比對 2026-10-05 匯入業主 ERP 成功的 samples/收款單_匯入測試_20261002.xlsx（客戶編號、金額、摘要），
// 並列出其他單據紀錄的分類與透字判斷。改 prompt 或規則後要跑一次。
// 結果快取在 samples/eval_out/raw/<model>@<版本>/，重跑只補沒跑過的頁（不重複付費）。
// 用法：npm run validate [-- --model gemini-3.8-flash] [-- --batch]（--batch：用批次模式，跟正式系統預設一樣）

import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { finalizeUpload } from "../supabase/functions/_shared/finalize.ts";
import { createBatch, getBatch, setThinkingLevel, type ThinkingLevel } from "../supabase/functions/_shared/gemini.ts";
import { Image } from "imagescript";
import {
  assembleFollowup, completePage, findContinuationGroups, followupItems, needsFollowUp, processPage, receiptParts, type PageResult,
} from "../supabase/functions/_shared/pipeline.ts";
import { CATEGORY_ZH, RECEIPT_PROMPT_VERSION, RECEIPT_SCHEMA, type ReceiptPage } from "../supabase/functions/_shared/prompts.ts";
import { entryValues, hasPayments, reviewReasons, summaryText } from "../supabase/functions/_shared/rules.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "gemini-3.8-flash";
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")
  .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)).filter(Boolean).map((m) => [m![1], m![2].trim().replace(/^["']|["']$/g, "")]));
const key = process.env.GEMINI_API_KEY ?? env.GEMINI_API_KEY;

const pagesDir = path.join(ROOT, "samples", "pages");
const batchMode = process.argv.includes("--batch");
// --thinking low|medium|high：Gemini 思考程度（預設用模型預設）；--run N：同條件重跑第 N 次（分開快取）
const arg = (k: string) => process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null;
const thinking = arg("--thinking") as ThinkingLevel;
setThinkingLevel(thinking);
const runTag = `${thinking ? `-think-${thinking}` : ""}${arg("--run") ? `-run${arg("--run")}` : ""}`;
const cacheDir = path.join(ROOT, "samples", "eval_out", "raw", `${model}@${RECEIPT_PROMPT_VERSION}-pipeline${batchMode ? "-batch" : ""}${runTag}`);
fs.mkdirSync(cacheDir, { recursive: true });
const pages = fs.readdirSync(pagesDir).filter((f) => f.endsWith(".jpg")).sort();

const results: Record<string, PageResult> = {};
const todo = pages.filter((f) => {
  const cache = path.join(cacheDir, f.replace(".jpg", ".json"));
  if (fs.existsSync(cache)) { results[f] = JSON.parse(fs.readFileSync(cache, "utf8")); return false; }
  return true;
});
const img = (f: string) => new Uint8Array(fs.readFileSync(path.join(pagesDir, f)));
// 左右翻轉圖，條件同上傳程式（長邊 1200、品質 80）
async function mirror(f: string): Promise<Uint8Array> {
  const im = await Image.decode(img(f));
  const { width: w, height: h, bitmap } = im;
  const px = new Uint32Array(bitmap.buffer, bitmap.byteOffset, w * h);
  for (let y = 0; y < h; y++) px.subarray(y * w, (y + 1) * w).reverse();
  if (Math.max(w, h) > 1200) w >= h ? im.resize(1200, Image.RESIZE_AUTO) : im.resize(Image.RESIZE_AUTO, 1200);
  return await im.encodeJPEG(80);
}
const save = (f: string, r: PageResult) => { fs.writeFileSync(path.join(cacheDir, f.replace(".jpg", ".json")), JSON.stringify(r, null, 1)); results[f] = r; };

if (batchMode && todo.length) {
  const name = await createBatch(key, model, "validate", todo.map((f) => ({ key: f, parts: receiptParts(img(f)), schema: RECEIPT_SCHEMA })));
  console.log("已送出批次", name);
  const t = Date.now();
  let st = await getBatch<ReceiptPage>(key, name);
  while (st.state === "pending" || st.state === "running") {
    await new Promise((r) => setTimeout(r, 15000));
    st = await getBatch<ReceiptPage>(key, name);
  }
  console.log(`批次完成 ${st.state}，${((Date.now() - t) / 1000).toFixed(0)} 秒`);
  if (st.state !== "succeeded") throw new Error(st.error);
  // 第一輪：有收款的頁面完成；沒收款的頁面送第二輪批次（同時送透字判斷與轉錄，跟正式系統一樣）
  const follow: { f: string; base: PageResult }[] = [];
  for (const r of st.results!) {
    if (!r.json) { console.log("❌", r.key, r.error); continue; }
    const base: PageResult = { receipt: r.json, mirror: null, other: null, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
    if (needsFollowUp(r.json)) follow.push({ f: r.key, base }); else save(r.key, base);
  }
  if (follow.length) {
    const items = (await Promise.all(follow.map(async ({ f }) => followupItems(f, img(f), await mirror(f))))).flat();
    const name2 = await createBatch(key, model, "validate-followup", items);
    console.log(`第二輪批次（${follow.length} 頁）`, name2);
    let st2 = await getBatch<unknown>(key, name2);
    while (st2.state === "pending" || st2.state === "running") { await new Promise((r) => setTimeout(r, 15000)); st2 = await getBatch<unknown>(key, name2); }
    console.log(`第二輪完成 ${st2.state}，從送出第一輪算起 ${((Date.now() - t) / 1000).toFixed(0)} 秒`);
    for (const { f, base } of follow) {
      const res = (k: string) => st2.results?.find((x) => x.key === `${f}|${k}`) as never;
      const page = assembleFollowup(base.receipt, base, res("mirror"), res("other"));
      save(f, page ?? await completePage(key, model, img(f), await mirror(f), base.receipt, base));
      if (!page) console.log("第二輪失敗，改用即時：", f);
    }
  }
} else {
  // 即時模式：4 頁並行
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < todo.length) {
      const f = todo[next++];
      const t = Date.now();
      save(f, await processPage(key, model, img(f), () => mirror(f)));
      console.log(`${f} ${((Date.now() - t) / 1000).toFixed(1)}s`);
    }
  }));
}

// 標準答案：ERP 匯入成功的那份
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(path.join(ROOT, "samples", "收款單_匯入測試_20261002.xlsx"));
const expected: string[] = [];
const master = new Set<string>();
wb.worksheets[0].eachRow((row, i) => {
  if (i === 1) return;
  const v = row.values as unknown[];
  master.add(String(v[5]));
  expected.push(`${v[5]} | ${v[7]} | ${v[9] ?? ""}`);
});

const got: string[] = [];
let auto = 0, review = 0, tin = 0, tout = 0;
console.log("\n頁面 | 種類 | 結果");
for (const f of pages) {
  const r = results[f];
  tin += r.inputTokens; tout += r.outputTokens;
  const rc = r.receipt;
  if (rc.page_type !== "not_a_document" && hasPayments(rc.entries)) {
    for (const e of rc.entries.filter((x) => x.payments.length)) {
      const v = entryValues(e);
      const reasons = reviewReasons(e, { inMaster: (c) => master.has(c) });
      reasons.length ? review++ : auto++;
      got.push(`${v.customer_code} | ${v.amount} | ${summaryText(v)}`);
      console.log(`${f} | ${rc.page_type} | ${v.customer_code} ${v.amount} ${reasons.length ? "複核：" + reasons.join("、") : "自動放行"}`);
    }
  } else {
    const cat = r.mirror?.mirrored ? "透字／空白（略過）" : r.other ? CATEGORY_ZH[r.other.category] : "?";
    console.log(`${f} | ${rc.page_type} | 其他單據紀錄：${cat}${r.other ? "｜" + r.other.summary : ""}`);
  }
}

const count = (a: string[]) => a.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
const ce = count(expected), cg = count(got);
const missing = [...ce].flatMap(([k, n]) => Array(Math.max(0, n - (cg.get(k) ?? 0))).fill(k));
const extra = [...cg].flatMap(([k, n]) => Array(Math.max(0, n - (ce.get(k) ?? 0))).fill(k));
console.log(`\n收款單：應有 ${expected.length} 筆，辨識 ${got.length} 筆（自動放行 ${auto}、複核 ${review}）`);
console.log(missing.length || extra.length ? `❌ 不一致\n  少了：${missing.join("\n        ")}\n  多了：${extra.join("\n        ")}` : "✅ 與 ERP 匯入測試檔完全一致（客戶編號、金額、摘要）");
const usd = (tin * 0.75 + tout * 3.75) / 1e6;
console.log(`用量：輸入 ${tin} tokens、輸出 ${tout} tokens，全部以即時價計約 US$${usd.toFixed(4)}（NT$${(usd * 32).toFixed(2)}）${batchMode ? "；批次模式的收款辨識部分為 5 折" : ""}`);

// 雲端「整理上傳檔」那一步（finalizeUpload）也跑一次：同一個掃描檔的頁面一起整理
const byFile = new Map<string, string[]>();
for (const f of pages) { const k = f.replace(/_p\d+\.jpg$/, ""); byFile.set(k, [...(byFile.get(k) ?? []), f]); }
const masterMap = new Map([...master].map((c) => [c, c]));
let fr = 0, fa = 0, fo = 0;
for (const [file, fs] of byFile) {
  const fp = fs.map((f, i) => ({ id: f, page_no: i + 1, status: "done" as const, result: results[f] }));
  const groups = findContinuationGroups(fp.map((p) => p.result.receipt));
  if (groups.length) console.log(`⚠️ ${file} 有跨頁對帳單組 ${JSON.stringify(groups)}（樣本裡沒有，應該是誤判）`);
  const { receipts, others } = finalizeUpload(fp, new Map(), masterMap);
  fr += receipts.length; fa += receipts.filter((r) => r.status === "auto").length; fo += others.length;
}
console.log(`整理結果：收款 ${fr} 筆（自動放行 ${fa}）、其他單據紀錄 ${fo} 列` + (fr === expected.length ? " ✅" : " ❌"));
