"use client";
// 其他單據紀錄（附件一項目 4）：沒有產生收款的頁面轉成文字留存，與收款單分開、由甲方手動下載；不匯入 ERP、不經複核
import { useState } from "react";
import { usePaged } from "@/components/Pager";
import { useToast } from "@/components/Toast";
import { taipeiDate, ymdToIso } from "@/lib/format";
import { must, useLive } from "@/lib/hooks";
import { supabaseBrowser } from "@/lib/supabase/client";

const HEAD = ["掃描日期", "來源頁面", "類別", "客戶編號", "客戶名稱", "重點摘要", "辨識全文"];
const toYmd = (s: string) => Number(s.replaceAll("-", ""));

export default function OthersPage() {
  const sb = supabaseBrowser();
  const toast = useToast();
  const [from, setFrom] = useState(taipeiDate());
  const [to, setTo] = useState(taipeiDate());
  const { data } = useLive(async () =>
    must(await sb.from("other_records").select("*, pages(page_no)").gte("scan_date", from).lte("scan_date", to).order("scan_date").order("created_at").limit(2000))
      .sort((a, b) => a.scan_date - b.scan_date || a.created_at.localeCompare(b.created_at) || (a.pages?.page_no ?? 0) - (b.pages?.page_no ?? 0)),
  [from, to], 30_000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paged = usePaged<any>(data ?? [], 10, `${from}-${to}`);
  const name = from === to ? `其他單據紀錄_${from}.xlsx` : `其他單據紀錄_${from}-${to}.xlsx`;

  async function download() {
    const res = await fetch(`/api/others?from=${from}&to=${to}`);
    if (!res.ok) return toast((await res.json()).error);
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="page-head"><h1>其他單據紀錄</h1><p>沒有產生收款的頁面也轉成文字留存，跟收款單分開下載，不會匯入 ERP</p></div>
      <div className="card">
        <div className="card-head">
          <label className="chk">掃描日期 <input className="inp" type="date" style={{ width: "auto" }} value={ymdToIso(from)} onChange={(e) => e.target.value && setFrom(toYmd(e.target.value))} /></label>
          <label className="chk">到 <input className="inp" type="date" style={{ width: "auto" }} value={ymdToIso(to)} onChange={(e) => e.target.value && setTo(toYmd(e.target.value))} /></label>
          <div className="right"><span className="sub">{data?.length ?? 0} 頁</span><button className="btn" type="button" disabled={!data?.length} onClick={download}>下載 Excel</button></div>
        </div>
        <div className="card-body">
          {data?.length ? (
            <>
              <div className="xl"><table>
                <thead><tr><th></th>{"ABCDEFG".split("").map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>
                  <tr className="hdr"><td className="rn">1</td>{HEAD.map((h) => <td key={h}>{h}</td>)}</tr>
                  {paged.rows.map((o, i) => (
                    <tr key={o.id}><td className="rn">{paged.offset + i + 2}</td><td className="n">{o.scan_date}</td><td>{o.source}</td><td>{o.category}</td>
                      <td className="t">{o.customer_code}</td><td>{o.customer_name}</td><td className="wrap">{o.summary}</td>
                      <td className="wrap" style={{ whiteSpace: "pre-wrap" }}>{o.full_text}</td></tr>
                  ))}
                </tbody>
              </table></div>
              <div className="xl-tabs"><span>其他單據紀錄</span></div>
              {paged.pager}
            </>
          ) : <div className="empty">{data ? "這段期間沒有其他單據。" : "載入中…"}</div>}
        </div>
      </div>
      <p className="note">類別只有四種：未收款對帳單、配送備忘、其他手寫、透字／空白（略過）。重點摘要與辨識全文是 AI 判讀的結果，用字會依單據不同，也可能有個別錯字。</p>
    </>
  );
}
