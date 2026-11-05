"use client";
// 客戶與單據查詢（2026-10-14 業主要求的客戶管理，與影像查詢合併）：
// 選客戶 → 列出這個客戶所有掃描進來的單據（有收款、沒收款都記），分類顯示並可直接看原圖。
// 也涵蓋附件一項目 3「影像查詢」：依掃描日期、客戶編號或名稱、金額查詢單據原圖與處理紀錄。
import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { PageImage } from "@/components/PageImage";
import { usePaged } from "@/components/Pager";
import { loadCustomers, PAGE_TYPE_ZH, withSources, type PageRow, type Receipt } from "@/lib/data";
import { fmt, retentionLeft } from "@/lib/format";
import { must, useLive } from "@/lib/hooks";
import { supabaseBrowser } from "@/lib/supabase/client";

type Cat = "paid" | "partial" | "unpaid" | "review" | "memo" | "skip";
const CAT: Record<Cat, [string, string]> = {
  paid: ["已收款", "ok"], partial: ["部分收款", "warn"], unpaid: ["未收款", "crit"], review: ["待複核", "info"], memo: ["其他備忘", "mute"], skip: ["透字／空白", "mute"],
};
type PageLite = Pick<PageRow, "id" | "page_no" | "image_path" | "created_at" | "image_deleted_at" | "page_type">;
interface Doc {
  key: string; code: string; date: number; kind: string; cat: Cat; total: number | null; amount: number | null;
  summary: string; exported: boolean | null; source: string; pages: PageLite[];
}

export default function CustomersPage() {
  const sb = supabaseBrowser();
  const [master, setMaster] = useState<Map<string, string>>(new Map());
  const [sel, setSel] = useState("__all");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | Cat>("all");
  const [view, setView] = useState<Doc | null>(null);
  useEffect(() => { loadCustomers().then(setMaster); }, []);

  const { data: docs } = useLive(async () => {
    let rq = sb.from("receipts").select("*").order("created_at", { ascending: false }).limit(sel === "__all" || sel === "__none" ? 500 : 2000);
    let oq = sb.from("other_records").select("*, pages(id, page_no, image_path, created_at, image_deleted_at, page_type)").order("created_at", { ascending: false }).limit(500);
    if (sel !== "__all" && sel !== "__none") { rq = rq.eq("customer_code", sel); oq = oq.eq("customer_code", sel); }
    const [rs, os] = await Promise.all([rq, oq]);
    const receipts = await withSources(must(rs) as Receipt[]);
    const out: Doc[] = receipts.map((r) => {
      const v = r.current_values;
      const cat: Cat = r.status === "review" ? "review" : r.status === "skipped" ? "unpaid" : v.remaining !== null ? "partial" : "paid";
      return {
        key: r.id, code: r.customer_code, date: r.scan_date, kind: PAGE_TYPE_ZH[r.pages[0]?.page_type ?? ""] ?? "單據", cat,
        total: v.corrected_total ?? v.printed_total, amount: r.status === "skipped" ? null : r.amount,
        summary: r.status === "review" ? "待複核：" + r.reasons.join("、") : r.status === "skipped" ? "複核時標記不產生收款" : r.summary,
        exported: r.status === "auto" || r.status === "reviewed" ? !!r.export_id : null, source: r.source, pages: r.pages,
      };
    });
    for (const o of must(os)) {
      const cat: Cat = o.category === "未收款對帳單" ? "unpaid" : o.category.startsWith("透字") ? "skip" : "memo";
      out.push({ key: o.id, code: o.customer_code ?? "", date: o.scan_date, kind: cat === "unpaid" ? "對帳單" : "單據背面／其他", cat,
        total: o.printed_total, amount: null, summary: o.summary, exported: null, source: o.source, pages: o.pages ? [o.pages] : [] });
    }
    return out.sort((a, b) => b.date - a.date || a.source.localeCompare(b.source, "zh-Hant", { numeric: true }));
  }, [sel], 60_000);

  const one = sel !== "__all" && sel !== "__none";
  const all = useMemo(() => {
    let d = docs ?? [];
    if (sel === "__none") d = d.filter((x) => !master.has(x.code));
    const t = q.trim();
    if (t) d = d.filter((x) => [x.code, master.get(x.code), x.source, x.date, x.amount, x.total, x.summary].some((f) => String(f ?? "").includes(t)));
    return d;
  }, [docs, sel, q, master]);
  const rows = filter === "all" ? all : all.filter((d) => d.cat === filter);
  const paged = usePaged(rows, 5, `${sel}|${q}|${filter}`);
  const cnt = (c: Cat) => all.filter((d) => d.cat === c).length;
  const paid = all.filter((d) => d.cat === "paid" || d.cat === "partial").reduce((a, d) => a + (d.amount ?? 0), 0);
  const owe = all.reduce((a, d) => a + (d.cat === "partial" && d.total !== null && d.amount !== null ? d.total - d.amount : d.cat === "unpaid" ? d.total ?? 0 : 0), 0);
  const codes = useMemo(() => [...master.keys()].sort(), [master]);

  return (
    <>
      <div className="page-head"><h1>客戶與單據查詢</h1><p>只要掃描進來的單據都查得到，有收款、沒收款都記在客戶底下，並可直接看原圖</p></div>
      <div className="card"><div className="card-body" style={{ display: "flex", flexWrap: "wrap", gap: "10px 16px", alignItems: "center" }}>
        <label htmlFor="cust" style={{ fontWeight: 600 }}>客戶</label>
        <select id="cust" className="inp" style={{ width: "auto", maxWidth: "100%" }} value={sel} onChange={(e) => { setSel(e.target.value); setFilter("all"); }}>
          <option value="__all">全部客戶（最近的單據）</option>
          {codes.map((c) => <option key={c} value={c}>{c}　{master.get(c)}</option>)}
          <option value="__none">未對應客戶（透字頁、客戶編號讀不到或不在主檔）</option>
        </select>
        <input className="inp" placeholder="搜尋客戶、金額、日期或來源頁面" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260, maxWidth: "100%" }} />
      </div></div>

      <div className="card">
        <div className="card-head"><h2>{one ? `${sel}　${master.get(sel) ?? ""}` : sel === "__all" ? "全部客戶" : "未對應客戶"}</h2>
          <span className="sub">{all.length ? `最近掃描 ${all[0].date}` : docs ? "沒有單據" : "載入中…"}</span></div>
        <div className="card-body nums">
          <div><b>{all.length}</b>單據總數</div>
          <div><b>NT${fmt(paid)}</b>已收款金額</div>
          <div className={owe ? "crit" : ""}><b>NT${fmt(owe)}</b>未收／剩餘金額</div>
          <div><b>{cnt("unpaid")}</b>未收款單據</div>
          <div><b>{cnt("review")}</b>待複核</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div className="subtabs">
          <button type="button" className={filter === "all" ? "on acc" : ""} onClick={() => setFilter("all")}>全部 {all.length}</button>
          {(Object.keys(CAT) as Cat[]).filter((c) => c !== "skip" || cnt(c)).map((c) => (
            <button key={c} type="button" className={filter === c ? "on acc" : ""} onClick={() => setFilter(c)}>{CAT[c][0]} {cnt(c)}</button>))}
        </div></div>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>掃描日期</th>{!one && <th>客戶</th>}<th>單據種類</th><th>分類</th><th className="num">印刷合計</th><th className="num">實收金額</th><th>摘要／內容</th><th>ERP 匯出</th><th>原圖</th></tr></thead>
          <tbody>
            {rows.length ? paged.rows.map((d) => {
              const left = d.pages.length ? Math.max(...d.pages.map((p) => retentionLeft(p.created_at, p.image_deleted_at))) : -1;
              return (
                <tr key={d.key}>
                  <td className="mono">{d.date}</td>
                  {!one && <td>{d.code ? <><span className="mono">{d.code}</span> {master.get(d.code) ?? "（不在主檔）"}</> : <span className="note">—</span>}</td>}
                  <td>{d.kind}</td><td><span className={`chip ${CAT[d.cat][1]}`}>{CAT[d.cat][0]}</span></td>
                  <td className="num">{fmt(d.total)}</td><td className="num">{d.amount === null ? "—" : fmt(d.amount)}</td>
                  <td>{d.summary}<br /><span className="note">{d.source}</span></td>
                  <td>{d.exported === null ? "—" : d.exported ? <span className="chip mute">已匯出</span> : <span className="chip warn">待匯出</span>}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {left < 0 ? <span className="note">原圖已過保存期限</span>
                      : <><button className="btn small" type="button" onClick={() => setView(d)}>看原圖</button><br /><span className="note">剩 {left} 天</span></>}
                  </td>
                </tr>
              );
            }) : <tr><td colSpan={one ? 8 : 9} className="empty">{docs ? "沒有符合的單據" : "載入中…"}</td></tr>}
          </tbody>
        </table></div>
        {paged.pager}
      </div>
      <p className="note">分類依辨識與複核結果自動判斷：已收款、部分收款（有剩餘未收）、未收款（未收款對帳單或複核時標記不產生收款）、待複核、其他備忘（單據背面手寫）、透字／空白。單據紀錄永久保存；雲端原圖保存 90 天，過期後到外接硬碟備份查。系統只辨識收款資料，不辨識品項明細。</p>
      {view && <Modal title={view.source} onClose={() => setView(null)}><PageImage pages={view.pages} height={640} /></Modal>}
    </>
  );
}
