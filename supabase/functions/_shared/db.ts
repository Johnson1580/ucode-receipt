// 雲端程式（Edge Functions，Deno）共用：service role 連線、台北日期、通知
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** 台北時間的 8 碼日期，例 20261016 */
export function taipeiDate(d = new Date()): number {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return Number(s.replaceAll("-", ""));
}

export function taipeiHour(d = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", hour12: false }).format(d));
}

/**
 * 建立通知；同一種類已有未解決的就不重複建立。
 * 使用者按「知道了」之後 4 小時內不再提醒同一件事（例如上傳程式還沒開機），避免每 10 分鐘推播一次。
 */
export async function notify(sb: SupabaseClient, kind: string, message: string) {
  const { data } = await sb.from("notifications").select("id").eq("kind", kind)
    .or(`resolved_at.is.null,created_at.gt.${new Date(Date.now() - 4 * 3600_000).toISOString()}`).limit(1);
  if (data?.length) return;
  await sb.from("notifications").insert({ kind, message });
}

export async function resolve(sb: SupabaseClient, kind: string) {
  await sb.from("notifications").update({ resolved_at: new Date().toISOString() }).eq("kind", kind).is("resolved_at", null);
}

/**
 * 把還沒送出的通知推播到手機（Web Push）。所有啟用中、在系統裡按過「開啟手機通知」的帳號都會收到。
 * 需要 Edge Function secret：VAPID_PUBLIC_KEY、VAPID_PRIVATE_KEY、VAPID_SUBJECT（mailto:…）；沒設定就只顯示在系統畫面。
 * web-push 的 sendNotification 固定走 node https，在 Deno 會出錯，所以只用它產生加密後的請求，再用 fetch 送出。
 */
export async function sendPendingNotifications(sb: SupabaseClient) {
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com";
  if (!pub || !priv) return;
  const { data: notes } = await sb.from("notifications").select("*").is("sent_at", null).order("created_at").limit(20);
  if (!notes?.length) return;
  const { data: subs } = await sb.from("push_subscriptions").select("id, endpoint, p256dh, auth, profiles!inner(active)").eq("profiles.active", true);
  const webpush = (await import("web-push")).default;
  for (const n of notes) {
    const payload = JSON.stringify({
      title: n.level === "alert" ? "優碼數位AI辨識系統：需要處理" : "優碼數位AI辨識系統",
      body: n.message, url: n.url ?? "/", tag: n.kind,
    });
    for (const s of subs ?? []) {
      try {
        const d = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
          { TTL: 86400, vapidDetails: { subject, publicKey: pub, privateKey: priv } });
        const r = await fetch(d.endpoint, { method: d.method, headers: d.headers as Record<string, string>, body: d.body });
        if (r.status === 404 || r.status === 410) await sb.from("push_subscriptions").delete().eq("id", s.id); // 手機取消訂閱或換機
      } catch (e) {
        console.error("push", s.endpoint.slice(0, 40), e);
      }
    }
    await sb.from("notifications").update({ sent_at: new Date().toISOString() }).eq("id", n.id);
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
