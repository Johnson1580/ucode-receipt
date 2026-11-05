// 一頁影像的完整辨識流程（雲端辨識程式與樣本驗證腳本共用）：
// 1. 收款辨識（RECEIPT_PROMPT）
// 2. 沒有收款的頁面（非單據頁、未收款對帳單）→ 先判斷是不是鏡像透字頁；是就略過，不是才全文轉錄成「其他單據紀錄」
//
// 透字判斷要「原圖＋左右翻轉圖」：只給原圖時，24 次判斷錯 2 次（把透字頁當正常頁，接著就會編造內容）；給翻轉圖 24 次全對（2026-10-20 實測）。
// 翻轉圖由常駐電腦的上傳程式產生（長邊 1200、品質 80，檔名 pNNN_m.jpg）：Supabase 雲端環境跑不了影像處理套件
// （imagescript 在雲端回 "unsupported arch/platform"，本機 Deno／Node 都能跑所以測試沒抓到）。

import { generateJson, imagePart, type BatchItem, type BatchResult, type Part } from "./gemini.ts";
import {
  MERGE_PROMPT_PREFIX, MIRROR_PROMPT, MIRROR_SCHEMA, OTHER_PROMPT, OTHER_SCHEMA, RECEIPT_PROMPT, RECEIPT_SCHEMA,
  type OtherPage, type ReceiptPage,
} from "./prompts.ts";
import { hasPayments } from "./rules.ts";

export interface PageResult {
  receipt: ReceiptPage;
  mirror: { mirrored: boolean; reason: string } | null; // 只有沒收款的頁面才判斷
  other: OtherPage | null;                               // 沒收款且不是透字頁才轉錄
  inputTokens: number;
  outputTokens: number;
}

export function receiptParts(jpeg: Uint8Array): Part[] {
  return [imagePart(jpeg), { text: RECEIPT_PROMPT }];
}

/** 收款辨識完之後：沒有收款的頁面判斷透字、轉錄（批次模式下這一步用即時呼叫，頁數少） */
export async function completePage(apiKey: string, model: string, jpeg: Uint8Array, mirror: Uint8Array, receipt: ReceiptPage,
  tokens: { inputTokens: number; outputTokens: number }): Promise<PageResult> {
  let tin = tokens.inputTokens, tout = tokens.outputTokens;
  if (!needsFollowUp(receipt)) {
    return { receipt, mirror: null, other: null, inputTokens: tin, outputTokens: tout };
  }
  const img = imagePart(jpeg);
  const m = await generateJson<{ mirrored: boolean; reason: string }>(
    apiKey, model, [img, imagePart(mirror), { text: MIRROR_PROMPT }], MIRROR_SCHEMA);
  tin += m.inputTokens; tout += m.outputTokens;
  if (m.json.mirrored) {
    return { receipt, mirror: m.json, other: null, inputTokens: tin, outputTokens: tout };
  }
  const o = await generateJson<OtherPage>(apiKey, model, [img, { text: OTHER_PROMPT }], OTHER_SCHEMA);
  return { receipt, mirror: m.json, other: o.json, inputTokens: tin + o.inputTokens, outputTokens: tout + o.outputTokens };
}

/** 即時模式：一頁從頭到尾（翻轉圖只有沒收款的頁面才需要，用到才讀） */
export async function processPage(apiKey: string, model: string, jpeg: Uint8Array, loadMirror: () => Promise<Uint8Array>): Promise<PageResult> {
  const r = await generateJson<ReceiptPage>(apiKey, model, receiptParts(jpeg), RECEIPT_SCHEMA);
  return completePage(apiKey, model, jpeg, needsFollowUp(r.json) ? await loadMirror() : new Uint8Array(), r.json, r);
}

/** 要再判斷透字、轉錄的頁面：非單據頁、沒有收款的對帳單。送貨單沒有收款、寫了作廢的直接進複核（finalize），不用轉錄 */
export function needsFollowUp(r: ReceiptPage): boolean {
  if (r.voided) return false;
  return r.page_type === "not_a_document" || (r.page_type === "statement" && !hasPayments(r.entries));
}

export const mirrorPath = (imagePath: string) => imagePath.replace(/\.jpg$/, "_m.jpg");

// ---------- 批次模式的第二輪（沒收款的頁面）----------
// 同時送「透字判斷」與「轉錄」兩個請求（只多等一輪批次）；透字頁的轉錄結果直接丟掉，不會存起來。

export function followupItems(pageId: string, jpeg: Uint8Array, mirror: Uint8Array): BatchItem[] {
  const img = imagePart(jpeg);
  return [
    { key: `${pageId}|mirror`, parts: [img, imagePart(mirror), { text: MIRROR_PROMPT }], schema: MIRROR_SCHEMA },
    { key: `${pageId}|other`, parts: [img, { text: OTHER_PROMPT }], schema: OTHER_SCHEMA },
  ];
}

/** 把第二輪的兩個結果組回一頁；透字判斷失敗、或不是透字頁但轉錄失敗，回傳 null（呼叫端改用即時處理） */
export function assembleFollowup(receipt: ReceiptPage, tokens: { inputTokens: number; outputTokens: number },
  mirror: BatchResult<{ mirrored: boolean; reason: string }> | undefined, other: BatchResult<OtherPage> | undefined): PageResult | null {
  if (!mirror?.json) return null;
  const tin = tokens.inputTokens + mirror.inputTokens + (other?.inputTokens ?? 0);
  const tout = tokens.outputTokens + mirror.outputTokens + (other?.outputTokens ?? 0);
  if (mirror.json.mirrored) return { receipt, mirror: mirror.json, other: null, inputTokens: tin, outputTokens: tout };
  if (!other?.json) return null;
  return { receipt, mirror: mirror.json, other: other.json, inputTokens: tin, outputTokens: tout };
}

/** 跨頁對帳單：把同一份的幾頁一起送，當成一份辨識 */
export async function mergeStatement(apiKey: string, model: string, jpegs: Uint8Array[]) {
  const parts = [...jpegs.map((b) => imagePart(b)), { text: MERGE_PROMPT_PREFIX + "\n\n" + RECEIPT_PROMPT }];
  return await generateJson<ReceiptPage>(apiKey, model, parts, RECEIPT_SCHEMA);
}

/**
 * 找出要合併的跨頁對帳單：同一個上傳檔裡，連續的對帳單頁面，後一頁標示「承接上一頁」或前一頁標示「延續到下一頁」。
 * pages 依頁碼排序；回傳每組的索引（只回傳 2 頁以上的組）。
 */
export function findContinuationGroups(pages: { page_type: string; continues_from_previous: boolean; continues_to_next: boolean }[]): number[][] {
  const groups: number[][] = [];
  let cur: number[] = [];
  pages.forEach((p, i) => {
    const prev = pages[i - 1];
    const joins = i > 0 && p.page_type === "statement" && prev.page_type === "statement" &&
      (p.continues_from_previous || prev.continues_to_next);
    if (joins) cur.push(i);
    else {
      if (cur.length > 1) groups.push(cur);
      cur = [i];
    }
  });
  if (cur.length > 1) groups.push(cur);
  return groups;
}
