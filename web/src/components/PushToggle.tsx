"use client";
// 「開啟手機通知」：註冊推播並把訂閱存到資料庫（push_subscriptions，只看得到自己的）。
// iPhone 要先「加入主畫面」再從主畫面的圖示開啟，Safari 才允許推播（iOS 16.4 以上）。
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { useToast } from "./Toast";

const b64ToBytes = (b64: string) => {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

type State = "loading" | "unsupported" | "ios-home" | "off" | "on" | "denied";

export function PushToggle() {
  const toast = useToast();
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone;
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return setState(ios && !standalone ? "ios-home" : "unsupported");
      const reg = await navigator.serviceWorker.register("/sw.js");
      if (Notification.permission === "denied") return setState("denied");
      setState((await reg.pushManager.getSubscription()) ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, []);

  async function enable() {
    setBusy(true);
    try {
      const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!key) throw new Error("系統尚未設定推播金鑰");
      if ((await Notification.requestPermission()) !== "granted") { setState("denied"); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      const j = sub.toJSON();
      const sb = supabaseBrowser();
      const { data: { user } } = await sb.auth.getUser();
      await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      const { error } = await sb.from("push_subscriptions").insert({
        user_id: user!.id, endpoint: sub.endpoint, p256dh: j.keys!.p256dh, auth: j.keys!.auth, user_agent: navigator.userAgent.slice(0, 200),
      });
      if (error) throw new Error(error.message);
      setState("on");
      toast("已開啟這支手機的通知");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function disable() {
    setBusy(true);
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await supabaseBrowser().from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      await sub.unsubscribe();
    }
    setState("off");
    setBusy(false);
    toast("已關閉這支手機的通知");
  }

  if (state === "loading" || state === "unsupported") return null;
  if (state === "ios-home") return <span className="note">iPhone 要收通知：Safari 分享 → 加入主畫面，再從主畫面圖示開啟。</span>;
  if (state === "denied") return <span className="note">通知已被封鎖，請到瀏覽器或手機設定允許通知。</span>;
  return state === "on"
    ? <button className="btn small" type="button" disabled={busy} onClick={disable}>關閉手機通知</button>
    : <button className="btn small" type="button" disabled={busy} onClick={enable}>開啟手機通知</button>;
}
