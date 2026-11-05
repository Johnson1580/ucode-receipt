import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entry } from "./prompts.ts";
import { entryValues, normalizeCode, reviewReasons, summaryText } from "./rules.ts";

const base: Entry = {
  customer_code: "00385", customer_name: "測試", printed_total: 1200, handwritten_corrected_total: null,
  payments: [{ date: "9/29", amount: 1200, method: "cash", check_number: null }],
  remaining_balance: null, date_corrections: [], notes: "",
};
const ctx = { inMaster: () => true };
const e = (o: Partial<Entry>): Entry => ({ ...base, ...o });

test("正常：單筆、金額＝合計 → 自動放行，摘要留空", () => {
  assert.deepEqual(reviewReasons(base, ctx), []);
  assert.equal(summaryText(entryValues(base)), "");
});

test("收支票、匯款也可以自動放行（2026-10-13）", () => {
  const chk = e({ payments: [{ date: null, amount: 1200, method: "check", check_number: "GB 0193805" }] });
  assert.deepEqual(reviewReasons(chk, ctx), []);
  assert.equal(summaryText(entryValues(chk)), "收支票 GB0193805 金額 1200");
  const tr = e({ payments: [{ date: "8/25", amount: 1200, method: "transfer", check_number: null }] });
  assert.deepEqual(reviewReasons(tr, ctx), []);
  assert.equal(summaryText(entryValues(tr)), "匯款");
});

test("部分付款 → 複核，摘要「部分付款，剩餘 N」", () => {
  const x = e({ printed_total: 46400, remaining_balance: 36400, payments: [{ date: "9/29", amount: 10000, method: "cash", check_number: null }] });
  assert.deepEqual(reviewReasons(x, ctx), ["部分付款，剩餘 36400"]);
  assert.equal(summaryText(entryValues(x)), "部分付款，剩餘 36400");
});

test("手改合計且實收＝手改後合計 → 放行（2026-10-20 放寬），摘要仍記「合計 870 手改 670」", () => {
  const x = e({ printed_total: 870, handwritten_corrected_total: 670, payments: [{ date: null, amount: 670, method: "cash", check_number: null }] });
  assert.deepEqual(reviewReasons(x, ctx), []);
  assert.equal(summaryText(entryValues(x)), "合計 870 手改 670");
  const y = e({ printed_total: 870, handwritten_corrected_total: 670, payments: [{ date: null, amount: 600, method: "cash", check_number: null }] });
  assert.deepEqual(reviewReasons(y, ctx), ["實收 600 與手改合計 670 不符"]);
  const z = e({ printed_total: null, handwritten_corrected_total: 670, payments: [{ date: null, amount: 670, method: "cash", check_number: null }] });
  assert.deepEqual(reviewReasons(z, ctx), ["讀不到印刷合計"]);
});

test("只有日期更改 → 放行（2026-10-20 放寬），摘要記錄", () => {
  const x = e({ date_corrections: [{ original: "2026/08/01", corrected: "09/01" }] });
  assert.deepEqual(reviewReasons(x, ctx), []);
  assert.equal(summaryText(entryValues(x)), "日期 2026/08/01 改 09/01");
});

test("金額不符、看不清楚、多筆、主檔沒有、方式不明 → 複核", () => {
  assert.deepEqual(reviewReasons(e({ payments: [{ date: null, amount: 1100, method: "cash", check_number: null }] }), ctx),
    ["實收 1100 與合計 1200 不符"]);
  assert.deepEqual(reviewReasons(e({ payments: [{ date: null, amount: null, method: "cash", check_number: null }] }), ctx),
    ["看不清楚收款金額"]);
  assert.deepEqual(reviewReasons(e({ payments: [base.payments[0], base.payments[0]] }), ctx), ["有 2 筆收款註記"]);
  assert.deepEqual(reviewReasons(base, { inMaster: () => false }), ["客戶編號不在主檔"]);
  assert.deepEqual(reviewReasons(e({ payments: [{ date: null, amount: 1200, method: "unknown", check_number: null }] }), ctx),
    ["收款方式不明"]);
  assert.deepEqual(reviewReasons(base, { ...ctx, merged: true }), ["跨頁對帳單（合併辨識，請確認）"]);
});

test("多項摘要以「；」連接", () => {
  const x = e({ printed_total: 3760, handwritten_corrected_total: 3700, date_corrections: [{ original: "9/1", corrected: "9/2" }],
    payments: [{ date: null, amount: 3700, method: "check", check_number: "AB1" }] });
  assert.equal(summaryText(entryValues(x)), "日期 9/1 改 9/2；合計 3760 手改 3700；收支票 AB1 金額 3700");
});

test("客戶編號正規化", () => {
  assert.equal(normalizeCode(" 302 - 02237-1 "), "302-02237-1");
  assert.equal(normalizeCode("０１６１８"), "01618");
});

test("客戶編號被手寫改掉 → 複核，並用手寫的新編號", () => {
  const x = e({ handwritten_customer_code: "03148" });
  assert.deepEqual(reviewReasons(x, ctx), ["客戶編號手改 00385 → 03148"]);
  assert.equal(entryValues(x).customer_code, "03148");
  assert.deepEqual(reviewReasons(e({ customer_info_corrected: true }), ctx), ["客戶名稱或地址有手寫更改"]);
});

test("整份扣除匯費 → 每筆都複核；複核時補的附註加在摘要最後", () => {
  assert.deepEqual(reviewReasons(base, { ...ctx, deductions: 18 }), ["整份扣除 18（匯費等），請在其中一筆的摘要註明"]);
  assert.equal(summaryText({ ...entryValues(e({ payments: [{ date: null, amount: 1200, method: "transfer", check_number: null }] })), note: "扣匯費 18" }),
    "匯款；扣匯費 18");
});
