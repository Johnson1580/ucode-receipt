import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { buildOtherXlsx, buildReceiptXlsx } from "./excel.ts";

// 型態要跟 2026-10-05 匯入 ERP 成功的檔案一致：日期、序號、金額、手續費存數字；存摺帳號、科目、客戶編號存文字
test("收款單欄位與資料型態", async () => {
  const buf = await buildReceiptXlsx(20261002, [
    { customer_code: "00385", customer_name: "範例商行", amount: 1200, summary: "" },
    { customer_code: "302-02237-1", customer_name: "佳美", amount: 10000, summary: "部分付款，剩餘 36400" },
  ], { bank_account: "0001", subject_code: "1141", fee: 0 });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  assert.equal(ws.name, "收款單");
  assert.deepEqual((ws.getRow(1).values as unknown[]).slice(1),
    ["日期", "序號", "收款存摺帳號", "科目編碼", "客戶/供應商編碼", "客戶/供應商名稱", "金額", "手續費", "摘要名稱"]);
  assert.deepEqual((ws.getRow(2).values as unknown[]).slice(1, 9), [20261002, 1, "0001", "1141", "00385", "範例商行", 1200, 0]);
  assert.equal(ws.getRow(2).getCell(9).value, null);
  assert.deepEqual((ws.getRow(3).values as unknown[]).slice(1), [20261002, 2, "0001", "1141", "302-02237-1", "佳美", 10000, 0, "部分付款，剩餘 36400"]);
  assert.equal(ws.rowCount, 3);
});

test("其他單據紀錄欄位", async () => {
  const buf = await buildOtherXlsx([{ scan_date: 20261007, source: "a.pdf 第 10 頁", category: "透字／空白（略過）",
    customer_code: null, customer_name: null, summary: "透字頁，無內容（略過）", full_text: "" }]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  assert.equal(ws.name, "其他單據紀錄");
  assert.deepEqual((ws.getRow(1).values as unknown[]).slice(1), ["掃描日期", "來源頁面", "類別", "客戶編號", "客戶名稱", "重點摘要", "辨識全文"]);
  assert.equal(ws.getRow(2).getCell(1).value, 20261007);
  assert.equal(ws.getRow(2).getCell(7).value, null);
});
