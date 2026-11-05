"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Me } from "@/lib/auth";
import { can } from "@/lib/roles";
import { supabaseBrowser } from "@/lib/supabase/client";
import { must, useLive } from "@/lib/hooks";
import { createContext, useContext } from "react";
import { ToastProvider } from "./Toast";

const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx)!;

export function Shell({ me, children }: { me: Me; children: React.ReactNode }) {
  const path = usePathname();
  const sb = supabaseBrowser();
  const { data, reload } = useLive(async () => {
    const [rev, ready, notes] = await Promise.all([
      sb.from("receipts").select("id", { count: "exact", head: true }).eq("status", "review"),
      sb.from("receipts").select("id", { count: "exact", head: true }).is("export_id", null).in("status", ["auto", "reviewed"]),
      sb.from("notifications").select("id, kind, message, created_at").eq("level", "alert").is("resolved_at", null).order("created_at", { ascending: false }),
    ]);
    return { review: rev.count ?? 0, ready: ready.count ?? 0, notes: must(notes) };
  }, [], 30_000);

  const item = (href: string, label: string, count?: number, green?: boolean) => (
    <Link href={href} className={(href === "/" ? path === "/" : path.startsWith(href)) ? "on" : ""}>
      {label}{!!count && <span className={`count${green ? " g" : ""}`}>{count}</span>}
    </Link>
  );

  return (
    <MeCtx value={me}>
    <ToastProvider>
      <div className="app">
        <aside className="side">
          <div className="brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="優碼數位" width={180} height={180} /><span>AI 收款單據辨識系統</span>
          </div>
          <nav className="nav" aria-label="系統功能">
            <div className="grp">收款辨識</div>
            {item("/", "處理總覽")}
            {item("/uploads", "掃描與辨識")}
            {item("/review", "待複核", data?.review)}
            {item("/records", "收款資料庫")}
            {can.export(me.roles) && item("/export", "匯出收款單", data?.ready, true)}
            {item("/others", "其他單據紀錄")}
            <div className="grp">客戶</div>
            {item("/customers", "客戶與單據查詢")}
            <div className="grp">管理</div>
            {item("/settings", "系統設定")}
          </nav>
        </aside>
        <main className="main">
          {!!data?.notes.length && (
            <div className="banner">
              {data.notes.map((n) => (
                <div key={n.id} className="reason crit"><b>通知</b><span style={{ flex: 1 }}>{n.message}</span>
                  <button className="btn small" type="button" onClick={async () => {
                    await sb.from("notifications").update({ resolved_at: new Date().toISOString() }).eq("id", n.id);
                    reload();
                  }}>知道了</button></div>
              ))}
            </div>
          )}
          {children}
        </main>
      </div>
    </ToastProvider>
    </MeCtx>
  );
}
