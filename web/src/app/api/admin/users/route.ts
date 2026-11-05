// 帳號管理（附件一項目 5）：老闆新增、停用帳號並指定角色。停用後不能登入，歷史紀錄保留原操作人。
import { NextResponse, type NextRequest } from "next/server";
import { meWithRole, type Role } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";

const ROLES: Role[] = ["owner", "accountant", "reviewer"];
const cleanRoles = (r: unknown) => (Array.isArray(r) ? ROLES.filter((x) => r.includes(x)) : []);

export async function POST(req: NextRequest) {
  if (!(await meWithRole("owner"))) return NextResponse.json({ error: "只有老闆可以管理帳號" }, { status: 403 });
  const { email, display_name, password, roles } = await req.json();
  const r = cleanRoles(roles);
  if (!email || !display_name || !r.length) return NextResponse.json({ error: "請填寫電子郵件、姓名，並至少選一個角色" }, { status: 400 });
  if (!password || password.length < 8) return NextResponse.json({ error: "初始密碼至少 8 個字元" }, { status: 400 });
  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.admin.createUser({ email: String(email).trim(), password, email_confirm: true });
  if (error) return NextResponse.json({ error: error.message.includes("already") ? "這個電子郵件已經有帳號" : error.message }, { status: 400 });
  const ins = await admin.from("profiles").insert({ id: data.user.id, email: data.user.email, display_name: String(display_name).trim(), roles: r });
  if (ins.error) {
    await admin.auth.admin.deleteUser(data.user.id);
    return NextResponse.json({ error: ins.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const me = await meWithRole("owner");
  if (!me) return NextResponse.json({ error: "只有老闆可以管理帳號" }, { status: 403 });
  const { id, roles, active, display_name } = await req.json();
  if (id === me.id && (active === false || (roles && !cleanRoles(roles).includes("owner")))) {
    return NextResponse.json({ error: "不能停用自己，或拿掉自己的老闆權限" }, { status: 400 });
  }
  const admin = supabaseAdmin();
  const patch: Record<string, unknown> = {};
  if (roles !== undefined) { patch.roles = cleanRoles(roles); if (!(patch.roles as Role[]).length) return NextResponse.json({ error: "至少選一個角色" }, { status: 400 }); }
  if (display_name !== undefined) patch.display_name = String(display_name).trim();
  if (active !== undefined) {
    patch.active = !!active;
    const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: active ? "none" : "876000h" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const { error } = await admin.from("profiles").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
