// 用正式系統的流程（批次模式：第一輪收款辨識、第二輪透字判斷＋轉錄、跨頁合併）跑一個資料夾的頁面，
// 產出逐頁結果與收款清單，給人工核對用（沒有標準答案的新樣本）。
// 頁面先用上傳程式的 render_pages 轉好（原圖 X.jpg ＋ 翻轉圖 X_m.jpg）。客戶主檔還沒有，「客戶編號不在主檔」這條不檢查。
// 用法：node scripts/run_batch.ts --pages samples/pages_mo --name 模
// 輸出：samples/<name>_辨識結果.xlsx（含真實客戶資料，不進 git）；結果快取在 samples/eval_out/raw/<model>@<版本>-<name>/

import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { createBatch, getBatch } from "../supabase/functions/_shared/gemini.ts";
import {
  assembleFollowup, completePage, findContinuationGroups, followupItems, mergeStatement, needsFollowUp, receiptParts, type PageResult,
} from "../supabase/functions/_shared/pipeline.ts";
import { RECEIPT_PROMPT_VERSION, RECEIPT_SCHEMA, type ReceiptPage } from "../supabase/functions/_shared/prompts.ts";
import { finalizeUpload } from "../supabase/functions/_shared/finalize.ts";
import { METHOD_ZH } from "./method_zh.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const pagesDir = path.resolve(ROOT, arg("--pages") ?? "samples/pages_mo");
const name = arg("--name") ?? path.basename(pagesDir);
const model = arg("--model") ?? "gemini-3.8-flash";
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")
  .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)).filter(Boolean).map((m) => [m![1], m![2].trim().replace(/^["']|["']$/g, "")]));
const key = process.env.GEMINI_API_KEY ?? env.GEMINI_API_KEY;
const cacheDir = path.join(ROOT, "samples", "eval_out", "raw", `${model}@${RECEIPT_PROMPT_VERSION}-${name}`);
fs.mkdirSync(cacheDir, { recursive: true });

const pages = fs.readdirSync(pagesDir).filter((f) => f.endsWith(".jpg") && !f.endsWith("_m.jpg")).sort();
const img = (f: string) => new Uint8Array(fs.readFileSync(path.join(pagesDir, f)));
const mir = (f: string) => new Uint8Array(fs.readFileSync(path.join(pagesDir, f.replace(/\.jpg$/, "_m.jpg"))));
const cacheOf = (f: string) => path.join(cacheDir, f.replace(".jpg", ".json"));
const results: Record<string, PageResult> = {};
for (const f of pages) if (fs.existsSync(cacheOf(f))) results[f] = JSON.parse(fs.readFileSync(cacheOf(f), "utf8"));
const save = (f: string, r: PageResult) => { fs.writeFileSync(cacheOf(f), JSON.stringify(r, null, 1)); results[f] = r; };

async function waitBatch<T>(batchName: string) {
  let st = await getBatch<T>(key, batchName);
  while (st.state === "pending" || st.state === "running") { await new Promise((r) => setTimeout(r, 15000)); st = await getBatch<T>(key, batchName); }
  if (st.state !== "succeeded") throw new Error(`批次失敗 ${st.error}`);
  return st.results!;
}

const t0 = Date.now();
const todo = pages.filter((f) => !results[f]);
if (todo.length) {
  // 第一輪：收款辨識（≤14MB 一批）
  const follow: { f: string; base: PageResult }[] = [];
  let chunk: string[] = [], bytes = 0;
  const chunks: string[][] = [];
  for (const f of todo) { const n = fs.statSync(path.join(pagesDir, f)).size; if (bytes + n > 14_000_000) { chunks.push(chunk); chunk = []; bytes = 0; } chunk.push(f); bytes += n; }
  if (chunk.length) chunks.push(chunk);
  const firsts = await Promise.all(chunks.map((c) => createBatch(key, model, `run-${name}`, c.map((f) => ({ key: f, parts: receiptParts(img(f)), schema: RECEIPT_SCHEMA })))));
  console.log(`第一輪送出 ${todo.length} 頁（${firsts.length} 批）`);
  for (const r of (await Promise.all(firsts.map((b) => waitBatch<ReceiptPage>(b)))).flat()) {
    if (!r.json) { console.log("❌ 第一輪失敗", r.key, r.error); continue; }
    const base: PageResult = { receipt: r.json, mirror: null, other: null, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
    if (needsFollowUp(r.json)) follow.push({ f: r.key, base }); else save(r.key, base);
  }
  console.log(`第一輪完成 ${((Date.now() - t0) / 1000).toFixed(0)} 秒；沒收款 ${follow.length} 頁送第二輪`);
  if (follow.length) {
    const b2 = await createBatch(key, model, `run-${name}-followup`, follow.flatMap(({ f }) => followupItems(f, img(f), mir(f))));
    const res = await waitBatch<unknown>(b2);
    for (const { f, base } of follow) {
      const get = (k: string) => res.find((x) => x.key === `${f}|${k}`) as never;
      save(f, assembleFollowup(base.receipt, base, get("mirror"), get("other")) ?? await completePage(key, model, img(f), mir(f), base.receipt, base));
    }
    console.log(`第二輪完成，從開始算 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  }
}

// 跨頁合併（即時）＋整理（同一個 PDF 當一個上傳檔）
const fp = pages.filter((f) => results[f]).map((f, i) => ({ id: f, page_no: i + 1, status: "done" as const, result: results[f] }));
const merged = new Map<string, { pageIds: string[]; receipt: ReceiptPage }>();
for (const g of findContinuationGroups(fp.map((p) => p.result.receipt))) {
  const gp = g.map((i) => fp[i]);
  console.log("跨頁合併：", gp.map((p) => p.id).join("、"));
  const r = await mergeStatement(key, model, gp.map((p) => img(p.id)));
  merged.set(gp[0].id, { pageIds: gp.map((p) => p.id), receipt: r.json });
}
const { receipts, others } = finalizeUpload(fp, merged, new Map([["*", ""]]) as never);
// 主檔還沒有：把「客戶編號不在主檔」拿掉再判斷放行
for (const r of receipts) {
  r.reasons = r.reasons.filter((x) => x !== "客戶編號不在主檔");
  r.status = r.reasons.length ? "review" : "auto";
}

const tin = Object.values(results).reduce((a, r) => a + r.inputTokens, 0), tout = Object.values(results).reduce((a, r) => a + r.outputTokens, 0);
const auto = receipts.filter((r) => r.status === "auto");
console.log(`\n${pages.length} 頁 → 收款 ${receipts.length} 筆（自動放行 ${auto.length}、複核 ${receipts.length - auto.length}）、其他單據 ${others.length} 列`);
const reasonCount = new Map<string, number>();
for (const r of receipts) for (const x of r.reasons) { const k = x.replace(/\d[\d,]*/g, "N"); reasonCount.set(k, (reasonCount.get(k) ?? 0) + 1); }
console.log("複核原因：", [...reasonCount].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join("、"));
console.log(`用量：輸入 ${tin}、輸出 ${tout} tokens；全批次價約 NT$${(((tin * 0.375 + tout * 1.875) / 1e6) * 32).toFixed(2)}`);

// Excel：收款、其他單據、逐頁
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("收款");
ws.columns = [{ header: "頁", width: 12 }, { header: "狀態", width: 10 }, { header: "客戶編號", width: 14 }, { header: "單據上名稱", width: 26 },
  { header: "印刷合計", width: 10 }, { header: "手改合計", width: 10 }, { header: "實收", width: 10 }, { header: "剩餘", width: 9 }, { header: "方式", width: 8 },
  { header: "支票號碼", width: 14 }, { header: "摘要", width: 34 }, { header: "複核原因", width: 40 }, { header: "AI 備註", width: 40 }];
for (const r of receipts) {
  const p = results[r.page_ids[0]];
  const e = (merged.get(r.page_ids[0])?.receipt ?? p.receipt).entries[r.entry_index];
  ws.addRow([r.page_ids.map((x) => x.replace(/^.*_p|\.jpg$/g, "")).join("+"), r.status === "auto" ? "自動放行" : "複核", r.customer_code, e?.customer_name ?? "",
    r.values.printed_total, r.values.corrected_total, r.values.amount, r.values.remaining, METHOD_ZH[r.values.method], r.values.check_number,
    r.summary, r.reasons.join("、"), [e?.notes, p.receipt.notes].filter(Boolean).join("；")]);
}
const wo = wb.addWorksheet("其他單據");
wo.columns = [{ header: "頁", width: 8 }, { header: "類別", width: 16 }, { header: "客戶編號", width: 14 }, { header: "客戶名稱", width: 24 }, { header: "重點摘要", width: 60 }];
for (const o of others) wo.addRow([o.page_no, o.category, o.customer_code, o.customer_name, o.summary]);
const wp = wb.addWorksheet("逐頁");
wp.columns = [{ header: "頁", width: 8 }, { header: "種類", width: 14 }, { header: "客戶區塊數", width: 10 }, { header: "AI 把握", width: 8 }, { header: "整頁備註", width: 80 }];
for (const p of fp) wp.addRow([p.page_no, p.result.receipt.page_type, p.result.receipt.entries.length, p.result.receipt.confidence, p.result.receipt.notes]);
const out = path.join(ROOT, "samples", `${name}_辨識結果.xlsx`);
await wb.xlsx.writeFile(out);
console.log("輸出：", path.relative(ROOT, out));
