// 常駐電腦的裝置金鑰：上傳金鑰（只能上傳）、備份金鑰（只能讀每日收款資料）。金鑰原文只在建立時顯示一次，資料庫只存雜湊。
import { createHash, randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { meWithRole } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  if (!(await meWithRole("owner"))) return NextResponse.json({ error: "只有老闆可以管理裝置" }, { status: 403 });
  const { name, kind } = await req.json();
  if (!name || !["uploader", "backup"].includes(kind)) return NextResponse.json({ error: "參數錯誤" }, { status: 400 });
  const token = `uc_${kind === "uploader" ? "up" : "bk"}_${randomBytes(32).toString("base64url")}`;
  const { error } = await supabaseAdmin().from("devices").insert({
    name: String(name).trim(), kind, token_hash: createHash("sha256").update(token).digest("hex"),
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ token });
}

export async function PATCH(req: NextRequest) {
  if (!(await meWithRole("owner"))) return NextResponse.json({ error: "只有老闆可以管理裝置" }, { status: 403 });
  const { id, active } = await req.json();
  const admin = supabaseAdmin();
  const { error } = await admin.from("devices").update({ active: !!active }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!active) {
    // 停用後，這台的「沒回報」「外接硬碟」通知一起關掉
    await admin.from("notifications").update({ resolved_at: new Date().toISOString() })
      .in("kind", [`uploader_offline:${id}`, `hdd:${id}`]).is("resolved_at", null);
  }
  return NextResponse.json({ ok: true });
}
