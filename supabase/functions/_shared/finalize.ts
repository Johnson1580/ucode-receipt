// 一個上傳檔的所有頁面都辨識完之後：合併跨頁對帳單 → 產生收款（自動放行／待複核）與其他單據紀錄。
// 純邏輯，不碰資料庫（方便用樣本測試）；寫入由呼叫端負責。

import { CATEGORY_ZH, SKIPPED_SUMMARY, type ReceiptPage } from "./prompts.ts";
import type { PageResult } from "./pipeline.ts";
import { entryValues, hasPayments, reviewReasons, summaryText, VOIDED_REASON, type ReceiptValues } from "./rules.ts";

export interface FinalPage {
  id: string;
  page_no: number;
  status: "done" | "failed";
  error?: string | null;
  result: PageResult | null;
}

export interface NewReceipt {
  page_ids: string[];
  entry_index: number;
  status: "auto" | "review";
  reasons: string[];
  values: ReceiptValues;
  customer_code: string;
  customer_name: string;
  amount: number | null;
  summary: string;
}

export interface NewOther {
  page_id: string;
  page_no: number;
  category: string;
  customer_code: string | null;
  customer_name: string | null;
  summary: string;
  full_text: string;
  printed_total: number | null;
}

const EMPTY: ReceiptValues = {
  customer_code: "", printed_total: null, corrected_total: null, amount: null, remaining: null,
  method: "unknown", check_number: null, date_corrections: [],
};

/**
 * pages 依頁碼排序。merged：跨頁合併後的辨識結果，key 是合併組第一頁的 id、value 是該組所有頁 id 與結果。
 */
export function finalizeUpload(
  pages: FinalPage[],
  merged: Map<string, { pageIds: string[]; receipt: ReceiptPage }>,
  master: Map<string, string>,
): { receipts: NewReceipt[]; others: NewOther[] } {
  const receipts: NewReceipt[] = [];
  const others: NewOther[] = [];
  const inGroup = new Set([...merged.values()].flatMap((g) => g.pageIds.slice(1)));

  for (const p of pages) {
    if (inGroup.has(p.id)) continue; // 已併入前一頁
    if (p.status === "failed" || !p.result) {
      receipts.push({ page_ids: [p.id], entry_index: 0, status: "review", reasons: [`AI 辨識失敗：${p.error ?? "未知錯誤"}`],
        values: EMPTY, customer_code: "", customer_name: "", amount: null, summary: "" });
      continue;
    }
    const group = merged.get(p.id);
    const rc = group?.receipt ?? p.result.receipt;
    const pageIds = group?.pageIds ?? [p.id];

    if (rc.page_type !== "not_a_document" && hasPayments(rc.entries)) {
      rc.entries.forEach((e, i) => {
        if (!e.payments.length) return; // 連鎖對帳單中沒收款的分店不產生收款單
        const v = entryValues(e);
        // 客戶主檔還沒匯入時不檢查編號（匯入後自動恢復）
        const reasons = reviewReasons(e, { inMaster: (c) => master.size === 0 || master.has(c), merged: !!group, deductions: rc.deductions, voided: rc.voided });
        receipts.push({
          page_ids: pageIds, entry_index: i, status: reasons.length ? "review" : "auto", reasons, values: v,
          customer_code: v.customer_code, customer_name: master.get(v.customer_code) ?? e.customer_name ?? "",
          amount: v.amount, summary: summaryText(v),
        });
      });
      continue;
    }
    // 送貨單沒有讀到收款註記 → 複核（2026-10-20：送貨單多是下貨收現，沒寫收款很少見，比較可能是 AI 漏讀；
    // 第二批樣本第 51 頁「收 5640」曾被讀成數字、判成未收款）。真的未收，複核人員按「不產生收款」。
    // 寫了「作廢」的單據也一律進複核、由人確認（2026-10-31 業主要求，原本會歸到其他單據紀錄）
    if (rc.page_type === "delivery_note" || rc.voided) {
      const e = rc.entries[0];
      const v = e ? entryValues(e) : EMPTY;
      receipts.push({ page_ids: pageIds, entry_index: 0, status: "review",
        reasons: rc.voided ? [VOIDED_REASON] : ["送貨單沒有讀到收款註記，若確實未收請按「不產生收款」"], values: v,
        customer_code: v.customer_code, customer_name: master.get(v.customer_code) ?? e?.customer_name ?? "", amount: null, summary: "" });
      continue;
    }
    // 沒有收款：其他單據紀錄（透字頁只記一列、不轉錄）
    const r = p.result;
    const first = rc.entries[0];
    if (r.mirror?.mirrored || !r.other || r.other.category === "bleed_through_or_blank") {
      others.push({ page_id: p.id, page_no: p.page_no, category: CATEGORY_ZH.bleed_through_or_blank, customer_code: null,
        customer_name: null, summary: SKIPPED_SUMMARY, full_text: "", printed_total: null });
    } else {
      const code = r.other.customer_code ?? first?.customer_code ?? null;
      others.push({
        page_id: p.id, page_no: p.page_no, category: CATEGORY_ZH[r.other.category],
        customer_code: code ? code.replace(/\s+/g, "") : null,
        customer_name: r.other.customer_name ?? first?.customer_name ?? null,
        summary: r.other.summary, full_text: r.other.full_text,
        printed_total: r.other.category === "unpaid_statement" ? first?.handwritten_corrected_total ?? first?.printed_total ?? null : null,
      });
    }
  }
  return { receipts, others };
}
