"use client";
// 處理總覽（附件一項目 3「處理狀況總覽」）：依掃描批次與日期顯示處理頁數、自動放行數與比例、待複核數、已匯出數
import Link from "next/link";
import { useState } from "react";
import { useMe } from "@/components/Shell";
import { fmt, taipeiDate, timeTW, ymdToIso } from "@/lib/format";
import { must, useLive } from "@/lib/hooks";
import { can } from "@/lib/roles";
import { supabaseBrowser } from "@/lib/supabase/client";

interface Stat {
  upload_id: string; file_name: string; created_at: string; upload_status: string; page_count: number;
  pages_done: number; pages_failed: number; auto: number; reviewed: number; review: number; skipped: number; exported: number; others: number;
}

export default function Dashboard() {
  const sb = supabaseBrowser();
  const me = useMe();
  const [date, setDate] = useState(taipeiDate());
  const { data } = useLive(async () => {
    const [stats, up, settings, usage, ready] = await Promise.all([
      sb.rpc("daily_stats", { p_date: date }),
      sb.rpc("uploader_status"),
      sb.from("settings").select("ai_paused, ai_pause_reason, ai_paused_at").single(),
      sb.rpc("month_usage"),
      sb.from("receipts").select("id", { count: "exact", head: true }).is("export_id", null).in("status", ["auto", "reviewed"]),
    ]);
    return { stats: must(stats) as Stat[], uploader: must(up)?.[0], settings: must(settings), usage: must(usage)?.[0], ready: ready.count ?? 0, now: Date.now() };
  }, [date], 15_000);

  const s = data?.stats ?? [];
  const sum = (k: keyof Stat) => s.reduce((a, x) => a + (x[k] as number), 0);
  const pages = sum("page_count"), done = sum("pages_done") + sum("pages_failed");
  const receipts = sum("auto") + sum("reviewed") + sum("review") + sum("skipped");
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) + "%" : "—");
  const up = data?.uploader;
  const upMin = up?.last_seen_at && data ? (data.now - new Date(up.last_seen_at).getTime()) / 60000 : Infinity;
  // 上傳程式沒在回報時，最後一次回報的硬碟狀態已經不可信，顯示未知
  const hdd = upMin > 30 ? undefined : up?.last_status?.hdd_connected;

  return (
    <>
      <div className="page-head">
        <h1>處理總覽</h1>
        <p>處理日期 <input className="inp" type="date" style={{ width: "auto", display: "inline-block" }} value={ymdToIso(date)}
          onChange={(e) => e.target.value && setDate(Number(e.target.value.replaceAll("-", "")))} /></p>
      </div>
      <div className="grid3">
        <div className="card status"><span className="k">掃描上傳程式（常駐電腦）</span>
          <span className="v"><i className={`dot ${!up ? "crit" : upMin > 30 ? "warn" : ""}`} />{!up ? "尚未安裝" : upMin > 30 ? "沒有回報" : "正常運作"}</span>
          <span className="d">{up ? `${up.name}${up.last_status?.version ? ` ${up.last_status.version} 版` : ""}・最近回報 ${timeTW(up.last_seen_at)}${up.last_status?.pending ? `・待上傳 ${up.last_status.pending} 個檔` : ""}` : "安裝後會顯示最近回報時間"}</span></div>
        <div className="card status"><span className="k">外接硬碟備份</span>
          <span className="v"><i className={`dot ${hdd === false ? "crit" : hdd ? "" : "warn"}`} />{hdd === false ? "未連接" : hdd ? "已連接" : upMin > 30 && up ? "未知（上傳程式沒有回報）" : "未知"}</span>
          <span className="d">{up?.last_status?.last_backup ? `上次每日備份 ${timeTW(up.last_status.last_backup)}` : "上傳程式會回報硬碟狀態"}</span></div>
        <div className="card status"><span className="k">AI 辨識服務（Google Gemini）</span>
          <span className="v"><i className={`dot ${data?.settings.ai_paused ? "crit" : ""}`} />{data?.settings.ai_paused ? "已暫停（額度或帳務）" : "正常"}</span>
          <span className="d">本月已辨識 {fmt(data?.usage?.pages ?? 0)} 頁</span></div>
      </div>

      <div className="card">
        <div className="card-head"><h2>{date === taipeiDate() ? "今日" : date} 處理狀況</h2></div>
        <div className="card-body nums">
          <div><b>{fmt(pages)}</b>掃描頁數</div>
          <div><b>{fmt(pages - done)}</b>辨識中</div>
          <div><b>{fmt(sum("auto"))}</b>自動放行（{pct(sum("auto"), receipts)}）</div>
          <div><b>{fmt(sum("reviewed"))}</b>已複核</div>
          <div className={sum("review") ? "crit" : ""}><b>{fmt(sum("review"))}</b>待複核</div>
          <div><b>{fmt(sum("exported"))}</b>已匯出</div>
          <div><b>{fmt(sum("others"))}</b>其他單據（不產生收款）</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>掃描批次</h2><span className="sub">{s.length} 批</span>
          <div className="right">
            {!!sum("review") && <Link className="btn primary" href="/review">前往待複核（{sum("review")}）</Link>}
            {can.export(me.roles) && !!data?.ready && <Link className="btn" href="/export">匯出收款單（{data.ready} 筆可匯出）</Link>}
          </div>
        </div>
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>上傳時間</th><th>檔名</th><th className="num">頁數</th><th>辨識</th><th className="num">自動放行</th><th className="num">已複核</th><th className="num">待複核</th><th className="num">不產生收款</th><th className="num">其他單據</th><th className="num">已匯出</th></tr></thead>
          <tbody>
            {s.length ? s.map((x) => (
              <tr key={x.upload_id}>
                <td className="mono">{timeTW(x.created_at, false)}</td>
                <td><Link href={`/uploads?id=${x.upload_id}`}>{x.file_name}</Link></td>
                <td className="num">{x.page_count}</td>
                <td>{x.upload_status === "done" ? <span className="chip ok">完成</span>
                  : x.upload_status === "uploading" ? <span className="chip mute">上傳中</span>
                  : <span className="chip info">辨識中 {x.pages_done + x.pages_failed}／{x.page_count}</span>}
                  {!!x.pages_failed && <span className="chip crit" style={{ marginLeft: 4 }}>失敗 {x.pages_failed}</span>}</td>
                <td className="num">{x.auto}</td><td className="num">{x.reviewed}</td><td className="num">{x.review}</td>
                <td className="num">{x.skipped}</td><td className="num">{x.others}</td><td className="num">{x.exported}</td>
              </tr>
            )) : <tr><td colSpan={10} className="empty">這一天沒有掃描資料。會計在掃描機按「收款單據」掃描後，檔案會自動上傳並出現在這裡。</td></tr>}
          </tbody>
        </table></div>
      </div>
    </>
  );
}
