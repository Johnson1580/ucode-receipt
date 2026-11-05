// 其他單據紀錄 Excel（附件一項目 4）：依掃描日期區間下載，由甲方手動下載留存
import { buildOtherXlsx } from "@shared/excel.ts";
import { NextResponse, type NextRequest } from "next/server";
import { meWithRole } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  if (!(await meWithRole("owner", "accountant", "reviewer"))) return NextResponse.json({ error: "請先登入" }, { status: 403 });
  const from = Number(req.nextUrl.searchParams.get("from"));
  const to = Number(req.nextUrl.searchParams.get("to") ?? from);
  if (!from || !to) return NextResponse.json({ error: "缺少日期" }, { status: 400 });
  const sb = await supabaseServer();
  const rows: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from("other_records").select("*, pages(page_no)").gte("scan_date", from).lte("scan_date", to)
      .order("scan_date").order("created_at").range(off, off + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    rows.push(...data);
    if (data.length < 1000) break;
  }
  // 同一批的頁面一起寫入、建立時間相同，依頁碼排序
  rows.sort((a, b) => a.scan_date - b.scan_date || a.created_at.localeCompare(b.created_at) || (a.pages?.page_no ?? 0) - (b.pages?.page_no ?? 0));
  const bytes = await buildOtherXlsx(rows.map((r) => ({ scan_date: r.scan_date, source: r.source, category: r.category,
    customer_code: r.customer_code, customer_name: r.customer_name, summary: r.summary, full_text: r.full_text })));
  const name = from === to ? `其他單據紀錄_${from}.xlsx` : `其他單據紀錄_${from}-${to}.xlsx`;
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
}
