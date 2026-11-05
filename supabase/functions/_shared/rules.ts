// 自動放行規則與摘要規則（附件一項目 2「總金額自動核對」、項目 4「摘要名稱」）。
// 雲端辨識程式與複核網頁共用這一份，兩邊算出來的結果才會一樣。

import type { DateCorrection, Entry, Method } from "./prompts.ts";

// 一筆收款（一個客戶區塊）的值：AI 辨識出來的，或複核人員修正後的
export interface ReceiptValues {
  customer_code: string;
  printed_total: number | null;
  corrected_total: number | null;   // 手寫更正後的合計
  amount: number | null;            // 實收金額
  remaining: number | null;         // 部分付款剩餘
  method: Method;
  check_number: string | null;
  date_corrections: DateCorrection[];
  note?: string;                    // 複核人員手動補的摘要（例如匯費、扣款記在哪一筆）
}

/** 客戶編號正規化：去空白、全形轉半形（AI 偶爾會抄成「302 - 02237-1」或全形數字） */
export function normalizeCode(code: string | null | undefined): string {
  return (code ?? "")
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－—–]/g, "-")
    .replace(/\s+/g, "");
}

export function entryValues(e: Entry): ReceiptValues {
  const p = e.payments[0];
  return {
    // 印刷編號被手寫改掉時，用手寫的新編號（一定會進複核，由人確認）
    customer_code: normalizeCode(e.handwritten_customer_code || e.customer_code),
    printed_total: e.printed_total,
    corrected_total: e.handwritten_corrected_total,
    amount: p?.amount ?? null,
    remaining: e.remaining_balance,
    method: p?.method ?? "unknown",
    check_number: p?.check_number ? p.check_number.replace(/\s+/g, "") : null,
    date_corrections: e.date_corrections ?? [],
  };
}

export interface ReviewContext {
  inMaster: (code: string) => boolean;  // 客戶編號在不在客戶主檔
  merged?: boolean;                      // 跨頁合併辨識的（樣本驗證前一律人工確認）
  deductions?: number | null;            // 整份扣除的匯費、手續費（要人決定記在哪一筆的摘要）
  voided?: boolean;                      // 單據寫了「作廢」等字樣
}

export const VOIDED_REASON = "單據上有「作廢」等字樣，請確認（確實作廢請按「不產生收款」）";

/**
 * 進人工複核的原因；空陣列 = 符合自動放行條件。
 * 放行條件（合約第八條第 2 項、附件一項目 2）：單筆收款，且手寫收款金額＝合計，且沒有部分付款。收現、收支票、匯款都適用。
 * 2026-10-20 使用者決定放寬（業主第二批樣本約 28% 的送貨單手改數量／合計，AI 判斷都正確）：
 *   - 合計被手改，但實收金額＝手改後的合計 → 放行（摘要照樣記「合計 X 手改 Y」）
 *   - 只有日期更改 → 放行（摘要照樣記「日期 A 改 B」）
 *   → 附件一的放行條件要跟業主確認更新。
 * 不採用 AI 自評信心分數；發票號碼不作為條件。
 */
export function reviewReasons(e: Entry, ctx: ReviewContext): string[] {
  const v = entryValues(e);
  const r: string[] = [];
  if (!v.customer_code) r.push("讀不到客戶編號");
  else if (!ctx.inMaster(v.customer_code)) r.push("客戶編號不在主檔");
  // 客戶被手寫改掉也是手寫更正（2026-10-20 第二批樣本：03090 劃掉改 03148，原本被自動放行、會記錯客戶）
  if (e.handwritten_customer_code) r.push(`客戶編號手改 ${normalizeCode(e.customer_code)} → ${normalizeCode(e.handwritten_customer_code)}`);
  if (e.customer_info_corrected) r.push("客戶名稱或地址有手寫更改");
  if (e.payments.length > 1) r.push(`有 ${e.payments.length} 筆收款註記`);
  if (v.amount === null) r.push("看不清楚收款金額");
  if (v.printed_total === null) r.push("讀不到印刷合計");
  if (v.remaining !== null) r.push(`部分付款，剩餘 ${v.remaining}`);
  else if (v.amount !== null && v.corrected_total !== null && v.amount !== v.corrected_total) {
    r.push(`實收 ${v.amount} 與手改合計 ${v.corrected_total} 不符`);
  } else if (v.amount !== null && v.printed_total !== null && v.corrected_total === null && v.amount !== v.printed_total) {
    r.push(`實收 ${v.amount} 與合計 ${v.printed_total} 不符`);
  }
  if (v.method === "unknown") r.push("收款方式不明");
  if (ctx.merged) r.push("跨頁對帳單（合併辨識，請確認）");
  if (ctx.deductions) r.push(`整份扣除 ${ctx.deductions}（匯費等），請在其中一筆的摘要註明`);
  if (ctx.voided) r.push(VOIDED_REASON);
  return r;
}

/**
 * 收款單「摘要名稱」：只記異狀，正常單據留空，多項以「；」連接（附件一項目 4）。
 * 收支票連同支票號碼與金額（2026-10-13 業主要求）。這套寫法已於 2026-10-05 匯入業主 ERP 測試成功。
 */
export function summaryText(v: ReceiptValues): string {
  const n: string[] = [];
  for (const dc of v.date_corrections) n.push(`日期 ${dc.original} 改 ${dc.corrected}`);
  if (v.corrected_total !== null) n.push(`合計 ${v.printed_total} 手改 ${v.corrected_total}`);
  if (v.remaining !== null) n.push(`部分付款，剩餘 ${v.remaining}`);
  else if (v.corrected_total === null && v.amount !== null && v.printed_total !== null && v.amount !== v.printed_total) {
    n.push(`實收 ${v.amount} 與合計 ${v.printed_total} 不符`);
  }
  if (v.method === "check") {
    n.push(["收支票", v.check_number ?? "", `金額 ${v.amount}`].filter(Boolean).join(" "));
  } else if (v.method === "transfer") {
    n.push("匯款");
  }
  if (v.note?.trim()) n.push(v.note.trim());
  return n.join("；");
}

/** 沒有收款註記的單據頁（未收款）：不產生收款單，改記到其他單據紀錄 */
export function hasPayments(entries: Entry[]): boolean {
  return entries.some((e) => e.payments.length > 0);
}
