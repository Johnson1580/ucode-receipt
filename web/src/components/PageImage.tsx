"use client";
import { useEffect, useState } from "react";
import { retentionLeft } from "@/lib/format";
import { signedUrl, type PageRow } from "@/lib/data";

/** 單據原圖：可放大、縮小、旋轉；超過 90 天顯示「原圖已過保存期限」 */
export function PageImage({ pages, height = 520 }: { pages: Pick<PageRow, "id" | "image_path" | "created_at" | "image_deleted_at" | "page_no">[]; height?: number }) {
  // 換單據時由呼叫端給新的 key 重新掛載，縮放與旋轉自然歸零
  const [loaded, setLoaded] = useState<{ key: string; urls: (string | null)[] } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);
  const key = pages.map((p) => p.id).join(",");
  useEffect(() => {
    let alive = true;
    Promise.all(pages.map((p) => (retentionLeft(p.created_at, p.image_deleted_at) < 0 ? null : signedUrl(p.image_path))))
      .then((urls) => alive && setLoaded({ key, urls }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const urls = loaded?.key === key ? loaded.urls : [];
  const expired = pages.every((p) => retentionLeft(p.created_at, p.image_deleted_at) < 0);
  return (
    <div>
      <div className="card-head" style={{ borderBottom: 0, paddingBottom: 0 }}>
        <span className="sub">{pages.length > 1 ? `共 ${pages.length} 頁（跨頁合併）` : ""}</span>
        <div className="tools">
          <button className="btn small" type="button" aria-label="縮小" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.2).toFixed(1)))}>－</button>
          <button className="btn small" type="button" aria-label="放大" onClick={() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(1)))}>＋</button>
          <button className="btn small" type="button" onClick={() => setRot((r) => (r + 90) % 360)}>旋轉</button>
        </div>
      </div>
      <div className="viewer" style={{ maxHeight: height }}>
        {expired ? (
          <div className="empty"><b>原圖已過保存期限</b><br />雲端原圖保存 90 天後自動刪除；收款與複核紀錄仍在系統中，原始掃描檔可到外接硬碟備份查詢。</div>
        ) : (
          <div className="holder" style={{ transform: `scale(${zoom}) rotate(${rot}deg)` }}>
            {pages.map((p, i) => urls[i]
              // eslint-disable-next-line @next/next/no-img-element
              ? <img key={p.id} className="scan" src={urls[i]!} alt={`第 ${p.page_no} 頁原圖`} style={{ marginBottom: 12 }} />
              : <div key={p.id} className="empty">{urls.length ? "原圖已過保存期限" : "載入中…"}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}
