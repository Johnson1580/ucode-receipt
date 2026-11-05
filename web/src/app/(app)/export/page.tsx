"use client";
// 匯出收款單（附件一項目 4）：格式依業主 ERP 收款單匯入範本，2026-10-05 匯入測試成功
// 2026-10-30 到場測試後：每筆可勾選，只匯出勾選的；沒勾的留著下次再匯出，序號依匯出的筆數 1、2、3 重編
import { useState } from "react";
import { useMe } from "@/components/Shell";
import { usePaged } from "@/components/Pager";
import { useToast } from "@/components/Toast";
import { fmt, taipeiDate, timeTW } from "@/lib/format";
import { must, useLive } from "@/lib/hooks";
import { can } from "@/lib/roles";
import { supabaseBrowser } from "@/lib/supabase/client";

const HEAD = ["日期", "序號", "收款存摺帳號", "科目編碼", "客戶/供應商編碼", "客戶/供應商名稱", "金額", "手續費", "摘要名稱"];

async function download(res: Response) {
  if (!res.ok) throw new Error((await res.json()).error ?? "下載失敗");
  const name = decodeURIComponent((res.headers.get("Content-Disposition") ?? "").split("''")[1] ?? "收款單.xlsx");
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
  return name;
}

type Settings = { bank_account: string; subject_code: string; fee: number };
type Row = { id: string; upload_id: string; customer_code: string; customer_name: string | null; amount: number | null; summary: string | null; page_no: number; entry_index: number };
type Group = { upload_id: string; file_name: string; created_at: string; rows: Row[] };

export default function ExportPage() {
  const sb = supabaseBrowser();
  const me = useMe();
  const toast = useToast();
  const today = taipeiDate();
  const { data, reload } = useLive(async () => {
    const [rows, review, settings, exps, cust] = await Promise.all([
      sb.from("receipts").select("id, upload_id, page_ids, customer_code, customer_name, amount, summary, entry_index").is("export_id", null).in("status", ["auto", "reviewed"]).limit(2000),
      sb.from("receipts").select("id", { count: "exact", head: true }).eq("status", "review"),
      sb.from("settings").select("bank_account, subject_code, fee").single(),
      sb.from("exports").select("id, file_name, row_count, total, created_at, profiles(display_name)").order("created_at", { ascending: false }).limit(30),
      sb.from("customers").select("code", { count: "exact", head: true }),
    ]);
    // 依掃描檔（PDF）分組，組內照頁碼排，跟匯出的 Excel 順序一樣（create_export 依頁碼、同頁第幾筆排序）
    const rs = must(rows) as (Omit<Row, "page_no"> & { page_ids: string[] })[];
    const pageIds = [...new Set(rs.map((r) => r.page_ids[0]))];
    const uploadIds = [...new Set(rs.map((r) => r.upload_id))];
    const [pages, uploads] = await Promise.all([
      pageIds.length ? sb.from("pages").select("id, page_no").in("id", pageIds) : { data: [], error: null },
      uploadIds.length ? sb.from("uploads").select("id, file_name, created_at").in("id", uploadIds) : { data: [], error: null },
    ]);
    const pageNo = new Map((must(pages) as { id: string; page_no: number }[]).map((p) => [p.id, p.page_no]));
    const groups: Group[] = (must(uploads) as { id: string; file_name: string; created_at: string }[])
      .sort((x, y) => x.created_at.localeCompare(y.created_at))
      .map((u) => ({
        upload_id: u.id, file_name: u.file_name, created_at: u.created_at,
        rows: rs.filter((r) => r.upload_id === u.id).map((r) => ({ ...r, page_no: pageNo.get(r.page_ids[0]) ?? 0 }))
          .sort((x, y) => x.page_no - y.page_no || x.entry_index - y.entry_index),
      }));
    return { groups, review: review.count ?? 0, s: must(settings) as Settings, exps: must(exps), hasMaster: (cust.count ?? 0) > 0 };
  }, [], 30_000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exps = usePaged<any>(data?.exps ?? [], 8);
  if (!can.export(me.roles)) return <div className="card empty">只有老闆與會計可以匯出收款單。</div>;
  const groups = data?.groups ?? [];

  return (
    <>
      <div className="page-head"><h1>匯出收款單</h1><p>格式依貴公司 ERP 收款單匯入範本，已於 2026/10/05 匯入測試成功。每個掃描檔（PDF）各匯出一個 Excel</p></div>
      {!!data?.review && <div className="reason warn"><b>還有 {data.review} 筆待複核</b><span>匯出只包含已放行的收款。待複核的處理完之後可以再匯出一次，已匯出的不會重複。</span></div>}
      {data && !groups.length && <div className="card empty">目前沒有待匯出的收款。</div>}
      {groups.length > 0 && <p className="hint" style={{ margin: "0 0 10px" }}>每個掃描檔分開匯出成一個 Excel。先按表格左上角的框全選，再把這次不匯出的取消勾選；沒勾的會留在這裡，下次再匯出。序號依勾選的筆數 1、2、3 重新編排。</p>}
      {groups.map((g) => <FileExport key={g.upload_id} g={g} s={data!.s} today={today} onDone={reload} />)}
      <div className="grid2">
        <div className="card"><div className="card-head"><h2>欄位填法</h2></div><div className="card-body"><dl className="kv">
          <dt>日期</dt><dd>處理當天，8 碼數字（{today}）</dd><dt>序號</dt><dd>1、2、3…，每個檔案從 1 開始</dd>
          <dt>收款存摺帳號／科目</dt><dd>{data?.s.bank_account}／{data?.s.subject_code}（系統設定可改）</dd>
          <dt>客戶編碼</dt><dd>照單據印的編號，保留開頭的 0</dd><dt>客戶名稱</dt><dd>依客戶主檔帶出{data && !data.hasMaster && "（尚未匯入客戶主檔）"}</dd>
          <dt>手續費</dt><dd>{data?.s.fee}</dd><dt>摘要名稱</dt><dd>只記異狀，正常單據留空</dd></dl></div></div>
        <div className="card"><div className="card-head"><h2>匯出紀錄</h2><span className="sub">可重新下載，內容與當時相同</span></div>
          <div className="tbl-wrap"><table className="tbl"><thead><tr><th>檔名</th><th className="num">筆數</th><th className="num">金額</th><th>時間</th><th></th></tr></thead><tbody>
            {exps.rows.map((e) => (
              <tr key={e.id}><td className="mono">{e.file_name}</td><td className="num">{e.row_count}</td><td className="num">{fmt(e.total)}</td>
                <td>{timeTW(e.created_at)} {e.profiles?.display_name}</td>
                <td><button className="btn small" type="button" onClick={() => fetch(`/api/export?id=${e.id}`).then(download).catch((x) => toast(String(x)))}>下載</button></td></tr>
            ))}
            {data && !data.exps.length && <tr><td colSpan={5} className="empty">還沒有匯出紀錄</td></tr>}
          </tbody></table></div>
          {exps.pager}</div>
      </div>
    </>
  );
}

/** 一個掃描檔（PDF）的收款：自己的全選、勾選與匯出按鈕，匯出成一個 Excel */
function FileExport({ g, s, today, onDone }: { g: Group; s: Settings; today: number; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // 資料每 30 秒重新整理：已經不在清單上的（例如別人匯出了）自動取消勾選
  const chosen = g.rows.filter((r) => picked.has(r.id));
  const total = chosen.reduce((a, r) => a + (r.amount ?? 0), 0);
  const allOn = chosen.length === g.rows.length;
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const seq = new Map<string, number>(chosen.map((r, i) => [r.id, i + 1]));
  const base = g.file_name.replace(/\.[^.]*$/, "").replace(/[\\/:*?"<>|]/g, "_").trim();

  async function doExport() {
    setBusy(true);
    try {
      const res = await fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: chosen.map((r) => r.id) }) });
      toast(`已下載 ${await download(res)}（${chosen.length} 筆）`); setPicked(new Set());
    } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
    onDone();
    setBusy(false);
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head"><h2>收款單_{today}{base && `_${base}`}.xlsx</h2>
        <span className="sub">掃描檔 {g.file_name}（{timeTW(g.created_at)}）・已勾選 {chosen.length}／{g.rows.length} 筆・合計 NT${fmt(total)}</span>
        <div className="right"><button className="btn primary" type="button" disabled={!chosen.length || busy} onClick={doExport}>{busy ? "匯出中…" : `匯出勾選的 ${chosen.length} 筆`}</button></div></div>
      <div className="card-body">
        <div className="xl" style={{ maxHeight: "70vh" }}><table>
          <thead><tr>
            <th className="pick"><input type="checkbox" aria-label={`全選 ${g.file_name}`} checked={allOn}
              ref={(el) => { if (el) el.indeterminate = chosen.length > 0 && !allOn; }}
              onChange={() => setPicked(allOn ? new Set() : new Set(g.rows.map((r) => r.id)))} /></th>
            <th></th>{"ABCDEFGHI".split("").map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            <tr className="hdr"><td className="pick"></td><td className="rn">1</td>{HEAD.map((h) => <td key={h}>{h}</td>)}</tr>
            {g.rows.map((r) => {
              const n = seq.get(r.id);
              return (
                <tr key={r.id} className={n ? "" : "off"} onClick={() => toggle(r.id)}>
                  <td className="pick"><input type="checkbox" aria-label={`勾選 ${r.customer_name ?? r.customer_code}`} checked={!!n}
                    onChange={() => toggle(r.id)} onClick={(e) => e.stopPropagation()} /></td>
                  <td className="rn">{n ? n + 1 : ""}</td><td className="n">{today}</td><td className="n">{n ?? "—"}</td>
                  <td className="t">{s.bank_account}</td><td className="t">{s.subject_code}</td><td className="t">{r.customer_code}</td>
                  <td>{r.customer_name}</td><td className="n">{r.amount}</td><td className="n">{s.fee}</td><td>{r.summary}</td></tr>
              );
            })}
          </tbody>
        </table></div>
        <div className="xl-tabs"><span>收款單</span></div>
      </div>
    </div>
  );
}
