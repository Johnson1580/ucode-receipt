// 匯出 Excel：收款單（匯入業主 ERP）與其他單據紀錄（業主留存）。
// ⚠️ 兩份格式都已定案：收款單 2026-10-05 匯入 ERP 測試成功；其他單據紀錄 2026-10-08 給業主看過。
// 欄位順序、資料型態（哪些存數字、哪些存文字）都不要改，改了要重新做 ERP 匯入測試。

import ExcelJS from "exceljs";

export interface ReceiptRow {
  customer_code: string;
  customer_name: string;
  amount: number;
  summary: string;
}

export interface ReceiptSettings {
  bank_account: string; // 收款存摺帳號（目前 0001）
  subject_code: string; // 科目編碼（目前 1141）
  fee: number;          // 手續費（目前 0）
}

const RECEIPT_HEADERS = ["日期", "序號", "收款存摺帳號", "科目編碼", "客戶/供應商編碼", "客戶/供應商名稱", "金額", "手續費", "摘要名稱"];

/** date：處理當天，8 碼數字（例 20261002）。序號每個檔從 1 開始。 */
export async function buildReceiptXlsx(date: number, rows: ReceiptRow[], s: ReceiptSettings): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("收款單");
  ws.columns = RECEIPT_HEADERS.map(() => ({ width: 15.1 }));
  ws.addRow(RECEIPT_HEADERS);
  rows.forEach((r, i) => {
    const row = ws.addRow([
      date,                 // 數字
      i + 1,                // 數字
      s.bank_account,       // 文字
      s.subject_code,       // 文字
      r.customer_code,      // 文字（保留開頭的 0）
      r.customer_name,
      r.amount,             // 數字
      s.fee,                // 數字
      r.summary || null,    // 正常單據留空
    ]);
    row.getCell(5).numFmt = "@";
  });
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export interface OtherRow {
  scan_date: number;     // 8 碼數字
  source: string;        // 「檔名.pdf 第 N 頁」
  category: string;      // CATEGORY_ZH 四種之一
  customer_code: string | null;
  customer_name: string | null;
  summary: string;
  full_text: string;
}

const OTHER_HEADERS = ["掃描日期", "來源頁面", "類別", "客戶編號", "客戶名稱", "重點摘要", "辨識全文"];
const OTHER_WIDTHS = [11, 34, 16, 14, 30, 40, 80];

export async function buildOtherXlsx(rows: OtherRow[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("其他單據紀錄", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = OTHER_WIDTHS.map((width) => ({ width }));
  const head = ws.addRow(OTHER_HEADERS);
  head.eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  });
  for (const r of rows) {
    const row = ws.addRow([r.scan_date, r.source, r.category, r.customer_code || null, r.customer_name || null,
      r.summary, r.full_text || null]);
    row.eachCell({ includeEmpty: true }, (c) => { c.alignment = { wrapText: true, vertical: "top" }; });
    row.getCell(4).numFmt = "@";
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

// ---------- 每日備份到外接硬碟用（給業主留存，格式不影響 ERP）----------

const STATUS_ZH: Record<string, string> = { auto: "自動放行", review: "待複核", reviewed: "已複核放行", skipped: "不產生收款" };

function simpleSheet(name: string, headers: string[], rows: unknown[][], widths: number[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = widths.map((width) => ({ width }));
  ws.addRow(headers).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  return wb;
}

// deno-lint-ignore no-explicit-any
export async function buildReceiptLogXlsx(receipts: any[]): Promise<Uint8Array> {
  const wb = simpleSheet("收款紀錄",
    ["處理日期", "狀態", "客戶編號", "客戶名稱", "金額", "摘要", "進複核原因", "AI 原始辨識（金額）", "放行時間", "已匯出"],
    receipts.map((r) => [r.scan_date, STATUS_ZH[r.status] ?? r.status, r.customer_code, r.customer_name, r.amount, r.summary,
      (r.reasons ?? []).join("、"), r.ai_values?.amount ?? null, r.released_at ?? "", r.export_id ? "是" : "否"]),
    [11, 12, 14, 30, 10, 36, 36, 16, 22, 8]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

// deno-lint-ignore no-explicit-any
export async function buildReviewLogXlsx(logs: any[]): Promise<Uint8Array> {
  const show = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const wb = simpleSheet("複核修正紀錄",
    ["時間", "複核人", "動作", "客戶編號", "客戶名稱", "修改欄位", "修改前", "修改後"],
    logs.map((l) => [l.created_at, l.profiles?.display_name ?? "", l.action === "approve" ? "確認放行" : "不產生收款",
      l.receipts?.customer_code ?? "", l.receipts?.customer_name ?? "", (l.changed_fields ?? []).join("、"),
      (l.changed_fields ?? []).map((f: string) => `${f}=${show(l.before_values?.[f])}`).join("；"),
      (l.changed_fields ?? []).map((f: string) => `${f}=${show(l.after_values?.[f])}`).join("；")]),
    [22, 12, 12, 14, 30, 24, 40, 40]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
