// 匯出收款單（附件一項目 4）
//   POST {ids}：把勾選的已放行收款（同一個掃描檔）標記為已匯出並下載 Excel，序號依匯出順序 1、2、3 重編（同一筆不會出現在兩次匯出中，由資料庫函式 create_export 保證）
//   GET ?id=：重新下載某次匯出（用當時的內容快照重新產生，內容一模一樣）
import { buildReceiptXlsx, type ReceiptRow, type ReceiptSettings } from "@shared/excel.ts";
import { NextResponse, type NextRequest } from "next/server";
import { meWithRole } from "@/lib/auth";
import { taipeiDate } from "@/lib/format";
import { supabaseServer } from "@/lib/supabase/server";

function xlsx(bytes: Uint8Array, name: string) {
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
}

export async function POST(req: NextRequest) {
  if (!(await meWithRole("owner", "accountant"))) return NextResponse.json({ error: "沒有匯出權限" }, { status: 403 });
  const { ids } = await req.json().catch(() => ({}));
  if (!Array.isArray(ids) || !ids.length) return NextResponse.json({ error: "請至少勾選一筆" }, { status: 400 });
  const sb = await supabaseServer();
  const { data: e, error } = await sb.rpc("create_export", { p_date: taipeiDate(), p_ids: ids });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return xlsx(await buildReceiptXlsx(e.export_date, e.rows as ReceiptRow[], e.settings as ReceiptSettings), e.file_name);
}

export async function GET(req: NextRequest) {
  if (!(await meWithRole("owner", "accountant"))) return NextResponse.json({ error: "沒有匯出權限" }, { status: 403 });
  const sb = await supabaseServer();
  const { data: e } = await sb.from("exports").select("*").eq("id", req.nextUrl.searchParams.get("id") ?? "").maybeSingle();
  if (!e) return NextResponse.json({ error: "找不到這次匯出" }, { status: 404 });
  return xlsx(await buildReceiptXlsx(e.export_date, e.rows, e.settings), e.file_name);
}
