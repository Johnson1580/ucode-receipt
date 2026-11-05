import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { supabaseServer } from "./supabase/server";

export type Role = "owner" | "accountant" | "reviewer";
export interface Me { id: string; email: string; display_name: string; roles: Role[] }

// 登入者 id：getClaims 在本機驗證簽章，不用連 Supabase（帳號停用由 profiles.active＋RLS 擋，也會在下一次換 token 時失效）
const currentUserId = cache(async (): Promise<string | null> => {
  const sb = await supabaseServer();
  const { data } = await sb.auth.getClaims();
  return data?.claims?.sub ?? null;
});

/** 目前登入者（含角色）；沒登入或帳號已停用就回登入頁 */
export async function requireMe(): Promise<Me> {
  const sb = await supabaseServer();
  const uid = await currentUserId();
  if (!uid) redirect("/login");
  const { data: p } = await sb.from("profiles").select("id, email, display_name, roles, active").eq("id", uid).maybeSingle();
  if (!p || !p.active) redirect("/login?disabled=1");
  return { id: p.id, email: p.email, display_name: p.display_name, roles: p.roles as Role[] };
}

/** API 用：不符合角色就回 null（呼叫端回 403） */
export async function meWithRole(...roles: Role[]): Promise<Me | null> {
  const sb = await supabaseServer();
  const uid = await currentUserId();
  if (!uid) return null;
  const { data: p } = await sb.from("profiles").select("id, email, display_name, roles, active").eq("id", uid).maybeSingle();
  if (!p || !p.active || !roles.some((r) => (p.roles as Role[]).includes(r))) return null;
  return { id: p.id, email: p.email, display_name: p.display_name, roles: p.roles as Role[] };
}
