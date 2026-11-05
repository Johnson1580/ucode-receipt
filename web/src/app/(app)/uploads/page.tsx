"use client";
// 掃描與辨識：每批上傳的時間、頁數、辨識進度與逐頁結果
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Modal } from "@/components/Modal";
import { usePaged } from "@/components/Pager";
import { PageImage } from "@/components/PageImage";
import { PAGE_TYPE_ZH, type PageRow, type Upload } from "@/lib/data";
import { timeTW } from "@/lib/format";
import { must, useLive } from "@/lib/hooks";
import { supabaseBrowser } from "@/lib/supabase/client";

function pageChip(p: PageRow) {
  if (p.status === "failed") return <span className="chip crit">辨識失敗</span>;
  if (p.status === "submitted") return <span className="chip info">批次辨識中…</span>;
  if (p.status !== "done") return <span className="chip info">{p.status === "processing" ? "AI 辨識中…" : "排隊中"}</span>;
  const r = p.result;
  if (r?.mirror?.mirrored) return <span className="chip mute">透字頁・略過</span>;
  if (r?.other) return <span className="chip info">其他單據</span>;
  return <span className="chip ok">{PAGE_TYPE_ZH[p.page_type ?? ""] ?? "完成"}</span>;
}

function Uploads() {
  const sb = supabaseBrowser();
  const id = useSearchParams().get("id");
  const [view, setView] = useState<PageRow | null>(null);
  const { data: uploads } = useLive(async () =>
    must(await sb.from("uploads").select("*").order("created_at", { ascending: false }).limit(60)) as Upload[], [], 15_000);
  const selected = uploads?.find((u) => u.id === id) ?? uploads?.[0];
  const { data: pages } = useLive(async () => selected
    ? must(await sb.from("pages").select("id, upload_id, page_no, image_path, status, page_type, created_at, image_deleted_at, error, result").eq("upload_id", selected.id).order("page_no")) as PageRow[]
    : [], [selected?.id], 10_000);
  const done = pages?.filter((p) => p.status === "done" || p.status === "failed").length ?? 0;
  const paged = usePaged(pages ?? [], 8, selected?.id);

  return (
    <>
      <div className="page-head"><h1>掃描與辨識</h1><p>會計在掃描機按「收款單據」，檔案自動上傳後由 AI 逐頁辨識</p></div>
      <div className="review">
        <div className="card">
          <div className="card-head"><h2>上傳批次</h2><span className="sub">最近 60 批</span></div>
          <ul className="qlist">
            {uploads?.map((u) => (
              <li key={u.id} className={`qitem ${u.id === selected?.id ? "sel" : ""}`}>
                <Link href={`/uploads?id=${u.id}`} style={{ textDecoration: "none", display: "grid", gap: 4 }}>
                  <div className="qtop"><strong>{u.file_name}</strong><span className="amt">{u.page_count} 頁</span></div>
                  <div className="qmeta">{timeTW(u.created_at)}・{u.status === "done" ? "完成" : u.status === "uploading" ? "上傳中" : "辨識中"}</div>
                </Link>
              </li>
            ))}
            {uploads && !uploads.length && <li className="empty">還沒有上傳的掃描檔</li>}
          </ul>
        </div>
        {selected && (
          <div className="card">
            <div className="card-head"><h2>{selected.file_name}</h2><span className="sub">{timeTW(selected.created_at)} 上傳・{selected.page_count} 頁</span>
              <div className="right">{selected.status === "done" ? <span className="chip ok">辨識完成</span> : <span className="chip info">已辨識 {done}／{selected.page_count}</span>}</div></div>
            <div className="card-body progress">
              <div className="bar"><i style={{ width: `${Math.round((done / Math.max(selected.page_count, 1)) * 100)}%` }} /></div>
              <span className="note">{selected.status === "done" ? "完成。自動放行的已進入收款資料庫；需要人看的已進入待複核；沒有收款的頁面已寫入其他單據紀錄。" : "辨識中，畫面會自動更新。批次辨識通常幾分鐘到 1 小時內完成。"}</span>
            </div>
            <div className="card-body pages">
              {paged.rows.map((p) => {
                const e = p.result?.receipt?.entries?.find((x: { payments: unknown[] }) => x.payments.length) ?? p.result?.receipt?.entries?.[0];
                return (
                  <button key={p.id} type="button" className="pg" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => setView(p)}>
                    <span className="t">第 {p.page_no} 頁</span>
                    <span>{e?.customer_code ? `${e.customer_code} ${e.customer_name ?? ""}` : p.result?.other?.summary?.slice(0, 18) ?? ""}</span>
                    {pageChip(p)}
                    {p.error && <span className="note">{p.error.slice(0, 60)}</span>}
                  </button>
                );
              })}
            </div>
            {paged.pager}
          </div>
        )}
      </div>
      {view && <Modal title={`${selected?.file_name} 第 ${view.page_no} 頁`} onClose={() => setView(null)}><PageImage pages={[view]} height={640} /></Modal>}
    </>
  );
}

export default function UploadsPage() {
  return <Suspense><Uploads /></Suspense>;
}
