// 客戶主檔匯入（附件一項目 5）：上傳 ERP 匯出的客戶 Excel，依「客戶編號、客戶名稱」新增或更新。
// 欄位自動找標題含「編號／代號／編碼」與「名稱」的欄；找不到就用第 1、2 欄。客戶編號一律當文字（保留開頭的 0）。
import ExcelJS from "exceljs";
import { NextResponse, type NextRequest } from "next/server";
import { meWithRole } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

const text = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && v !== null && "richText" in v) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
  if (typeof v === "object" && v !== null && "result" in v) return String((v as { result: unknown }).result ?? "");
  return String(v);
};

export async function POST(req: NextRequest) {
  if (!(await meWithRole("owner"))) return NextResponse.json({ error: "只有老闆可以匯入客戶主檔" }, { status: 403 });
  const file = (await req.formData()).get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "請選擇檔案" }, { status: 400 });
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(Buffer.from(await file.arrayBuffer()) as unknown as ArrayBuffer); }
  catch { return NextResponse.json({ error: "讀不到這個檔案，請用 .xlsx 格式" }, { status: 400 }); }
  const ws = wb.worksheets[0];
  let codeCol = 1, nameCol = 2, headerRow = 0;
  for (let r = 1; r <= Math.min(10, ws.rowCount) && !headerRow; r++) {
    const cells = (ws.getRow(r).values as unknown[]).map(text);
    const c = cells.findIndex((x) => /編號|代號|編碼|代碼/.test(x));
    const n = cells.findIndex((x) => /名稱/.test(x) && !/編號|代號/.test(x));
    if (c > 0 && n > 0) { codeCol = c; nameCol = n; headerRow = r; }
  }
  const rows = new Map<string, string>();
  ws.eachRow((row, i) => {
    if (i <= headerRow) return;
    const cell = row.getCell(codeCol);
    // 數字格式的編號會掉開頭的 0：照儲存格顯示的格式補回來（例如格式 00000）
    let code = text(cell.value).trim();
    const fmt = cell.numFmt ?? "";
    if (typeof cell.value === "number" && /^0+$/.test(fmt)) code = code.padStart(fmt.length, "0");
    const name = text(row.getCell(nameCol).value).trim();
    if (code && name) rows.set(code.replace(/\s+/g, ""), name);
  });
  if (!rows.size) return NextResponse.json({ error: "檔案裡找不到客戶資料" }, { status: 400 });
  const sb = await supabaseServer();
  const list = [...rows].map(([code, name]) => ({ code, name, updated_at: new Date().toISOString() }));
  for (let i = 0; i < list.length; i += 500) {
    const { error } = await sb.from("customers").upsert(list.slice(i, i + 500), { onConflict: "code" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const numericCodes = list.filter((c) => /^\d{1,4}$/.test(c.code)).length;
  return NextResponse.json({ count: list.length, warning: numericCodes ? `有 ${numericCodes} 筆客戶編號少於 5 碼，可能是 Excel 把開頭的 0 去掉了，請確認。` : null });
}
