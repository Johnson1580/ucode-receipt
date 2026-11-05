"use client";
// 收款資料庫：每一筆收款都保留來源單據與處理紀錄
import { useState } from "react";
import { Modal } from "@/components/Modal";
import { usePaged } from "@/components/Pager";
import { PageImage } from "@/components/PageImage";
import { withSources, type Receipt } from "@/lib/data";
import { fmt, taipeiDate } from "@/lib/format";
import { must, useLive } from "@/lib/hooks";
import { supabaseBrowser } from "@/lib/supabase/client";

type Row = Awaited<ReturnType<typeof withSources<Receipt>>>[number];
const STATUS: Record<string, [string, string]> = { auto: ["自動放行", "ok"], reviewed: ["已複核", "info"], review: ["待複核", "warn"], skipped: ["不產生收款", "mute"] };

export default function RecordsPage() {
  const sb = supabaseBrowser();
  const [filter, setFilter] = useState<"all" | "today" | "pending">("today");
  const [q, setQ] = useState("");
  const [view, setView] = useState<Row | null>(null);
  const { data } = useLive(async () => {
    let query = sb.from("receipts").select("*").order("created_at", { ascending: false }).order("entry_index").limit(300);
    if (filter === "today") query = query.eq("scan_date", taipeiDate());
    if (filter === "pending") query = query.is("export_id", null).in("status", ["auto", "reviewed"]);
    const t = q.trim().replace(/[,()%*\\]/g, ""); // 避免影響查詢語法
    if (t) query = /^\d+$/.test(t) ? query.or(`customer_code.ilike.%${t}%,amount.eq.${t}`) : query.or(`customer_code.ilike.%${t}%,customer_name.ilike.%${t}%`);
    return withSources(must(await query) as Receipt[]);
  }, [filter, q], 30_000);

  const paged = usePaged(data ?? [], 8, `${filter}|${q}`);
  return (
    <>
      <div className="page-head"><h1>收款資料庫</h1><p>每一筆收款都保留來源單據、AI 原始辨識值與處理紀錄</p></div>
      <div className="card">
        <div className="card-head">
          <div className="subtabs">
            {([["today", "今日"], ["pending", "尚未匯出"], ["all", "全部（最近 300 筆）"]] as const).map(([k, l]) => (
              <button key={k} type="button" className={filter === k ? "on acc" : ""} onClick={() => setFilter(k)}>{l}</button>))}
          </div>
          <div className="right"><input className="inp" placeholder="搜尋客戶編號、名稱或金額" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} /></div>
        </div>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>處理日期</th><th>客戶編號</th><th>客戶名稱</th><th className="num">金額</th><th>狀態</th><th>摘要</th><th>匯出</th><th>來源頁面</th></tr></thead>
          <tbody>
            {data?.length ? paged.rows.map((r) => {
              const edited = r.status === "reviewed" && JSON.stringify(r.ai_values) !== JSON.stringify(r.current_values);
              return (
                <tr key={r.id}>
                  <td className="mono">{r.scan_date}</td><td className="mono">{r.customer_code}</td><td>{r.customer_name}</td>
                  <td className="num">{fmt(r.amount)}</td>
                  <td><span className={`chip ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span></td>
                  <td>{r.summary}{r.status === "review" && <span className="note">{r.reasons.join("、")}</span>}</td>
                  <td>{r.status === "skipped" || r.status === "review" ? "—" : r.export_id ? <span className="chip mute">已匯出</span> : <span className="chip warn">待匯出</span>}</td>
                  <td className="note"><button className="btn small" type="button" onClick={() => setView(r)}>看原圖</button> {r.source}
                    {edited && <><br /><span className="chip warn">人工修正</span></>}</td>
                </tr>
              );
            }) : <tr><td colSpan={8} className="empty">{data ? "沒有符合的資料" : "載入中…"}</td></tr>}
          </tbody>
        </table></div>
        {paged.pager}
      </div>
      <p className="note">每天會把當日收款紀錄、複核修正紀錄與收款單 Excel 備份到常駐電腦的外接硬碟。</p>
      {view && <Modal title={view.source} onClose={() => setView(null)}><PageImage pages={view.pages} height={640} /></Modal>}
    </>
  );
}
