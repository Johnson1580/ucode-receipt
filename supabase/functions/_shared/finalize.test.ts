import assert from "node:assert/strict";
import { test } from "node:test";
import { finalizeUpload, type FinalPage } from "./finalize.ts";
import type { Entry, OtherPage, ReceiptPage } from "./prompts.ts";
import { VOIDED_REASON } from "./rules.ts";

const entry: Entry = {
  customer_code: "00385", customer_name: "測試", printed_total: 1200, handwritten_corrected_total: null,
  payments: [{ date: "9/29", amount: 1200, method: "cash", check_number: null }],
  remaining_balance: null, date_corrections: [], notes: "",
};
const page = (receipt: Partial<ReceiptPage>, other: OtherPage | null = null): FinalPage => ({
  id: "p1", page_no: 1, status: "done",
  result: {
    receipt: { page_type: "delivery_note", entries: [entry], invoice_numbers: [], continues_from_previous: false, continues_to_next: false,
      confidence: "high", notes: "", ...receipt },
    mirror: other ? { mirrored: false, reason: "" } : null, other, inputTokens: 0, outputTokens: 0,
  },
});
const master = new Map([["00385", "範例商行"]]);
const run = (p: FinalPage) => finalizeUpload([p], new Map(), master);

test("正常送貨單 → 自動放行", () => {
  const { receipts, others } = run(page({}));
  assert.equal(receipts[0].status, "auto");
  assert.equal(others.length, 0);
});

test("寫了作廢、有收款註記 → 複核，不自動放行（2026-10-31）", () => {
  const { receipts } = run(page({ voided: true }));
  assert.equal(receipts[0].status, "review");
  assert.ok(receipts[0].reasons.includes(VOIDED_REASON));
});

test("寫了作廢、沒有收款的對帳單或非單據頁 → 複核，不歸其他單據紀錄（2026-10-31）", () => {
  const unpaid = { ...entry, payments: [] };
  for (const rc of [{ page_type: "statement" as const, entries: [unpaid] }, { page_type: "not_a_document" as const, entries: [] }]) {
    const { receipts, others } = run(page({ ...rc, voided: true }));
    assert.equal(others.length, 0, rc.page_type);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, "review");
    assert.deepEqual(receipts[0].reasons, [VOIDED_REASON]);
  }
  const { receipts } = run(page({ page_type: "delivery_note", entries: [unpaid], voided: true }));
  assert.deepEqual(receipts[0].reasons, [VOIDED_REASON]);
  assert.equal(receipts[0].customer_code, "00385");
});

test("沒寫作廢、沒收款的對帳單 → 照舊歸其他單據紀錄", () => {
  const other = { category: "unpaid_statement" as const, customer_code: "00385", customer_name: "測試", summary: "未收款", full_text: "x" };
  const { receipts, others } = run(page({ page_type: "statement", entries: [{ ...entry, payments: [] }] }, other));
  assert.equal(receipts.length, 0);
  assert.equal(others[0].category, "未收款對帳單");
});
