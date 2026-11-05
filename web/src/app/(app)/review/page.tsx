"use client";
// 待複核（附件一項目 3）：左側原圖、右側辨識欄位；修正後確認放行，或標記「不產生收款」。
// 摘要用 _shared/rules.ts 的 summaryText()，跟雲端辨識程式同一套規則。
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { summaryText, type ReceiptValues } from "@shared/rules.ts";
import { PageImage } from "@/components/PageImage";
import { useMe } from "@/components/Shell";
import { useToast } from "@/components/Toast";
import { loadCustomers, METHOD_ZH, PAGE_TYPE_ZH, withSources, type Receipt } from "@/lib/data";
import { fmt } from "@/lib/format";
import { must, useLive } from "@/lib/hooks";
import { can } from "@/lib/roles";
import { supabaseBrowser } from "@/lib/supabase/client";

type Row = Awaited<ReturnType<typeof withSources<Receipt>>>[number];
type NumKey = "printed_total" | "corrected_total" | "amount" | "remaining";

export default function ReviewPage() {
  const sb = supabaseBrowser();
  const me = useMe();
  const toast = useToast();
  const [sel, setSel] = useState<string | null>(null);
  const [master, setMaster] = useState<Map<string, string>>(new Map());
  useEffect(() => { loadCustomers().then(setMaster); }, []);

  const { data: queue, reload } = useLive(async () => {
    const rows = must(await sb.from("receipts").select("*").eq("status", "review").order("created_at").order("entry_index"));
    return withSources(rows as Receipt[]);
  }, [], 30_000);

  const current = queue?.find((r) => r.id === sel) ?? queue?.[0] ?? null;

  if (!queue) return <div className="page-head"><h1>待複核</h1><p>載入中…</p></div>;
  if (!queue.length) {
    return (
      <>
        <div className="page-head"><h1>待複核</h1></div>
        <div className="card empty"><b style={{ color: "var(--accent)" }}>目前沒有待複核的單據</b><br />
          {can.export(me.roles) && <><br /><Link className="btn primary" href="/export">前往匯出收款單</Link></>}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head"><h1>待複核</h1><p>AI 辨識不確定、或有異狀的單據，由人對照原圖確認</p></div>
      <div className="review">
        <div className="card">
          <div className="card-head"><h2>待複核清單</h2><span className="sub">{queue.length} 筆</span></div>
          <ul className="qlist">
            {queue.map((x) => (
              <li key={x.id} className={`qitem ${x.id === current?.id ? "sel" : ""}`} tabIndex={0}
                onClick={() => setSel(x.id)} onKeyDown={(e) => e.key === "Enter" && setSel(x.id)}>
                <div className="qtop"><strong>{master.get(x.customer_code) || x.customer_name || x.customer_code || "（讀不到客戶）"}</strong>
                  <span className="amt">{x.amount === null ? "？" : "NT$" + fmt(x.amount)}</span></div>
                <div className="qmeta">{x.customer_code}・{x.source}</div>
                <span className={`chip ${x.reasons.some((r) => /看不清|不在主檔|讀不到|失敗/.test(r)) ? "crit" : "warn"}`}>{x.reasons[0]}</span>
              </li>
            ))}
          </ul>
        </div>
        {current && <ReviewForm key={current.id} row={current} master={master} onDone={(msg) => { toast(msg); setSel(null); reload(); }} />}
      </div>
    </>
  );
}

function ReviewForm({ row, master, onDone }: { row: Row; master: Map<string, string>; onDone: (msg: string) => void }) {
  const sb = supabaseBrowser();
  const ai = row.ai_values;
  const [v, setV] = useState<ReceiptValues>(row.current_values);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const summary = useMemo(() => summaryText(v), [v]);
  const page = row.pages[0];
  const entry = page?.result?.receipt?.entries?.[row.entry_index];
  // 客戶主檔還沒匯入：名稱用單據上印的（匯入後改依主檔、並檢查編號）
  const masterEmpty = master.size === 0;
  const name = master.get(v.customer_code) ?? (masterEmpty ? row.customer_name || entry?.customer_name || v.customer_code : "");
  const notes = [entry?.notes, page?.result?.receipt?.notes].filter(Boolean).join("；");
  const canApprove = !!name && v.amount !== null && v.amount > 0;

  const num = (k: NumKey, label: string, ph = "") => {
    const changed = (v[k] ?? null) !== (ai[k] ?? null);
    return (
      <div className={`field ${changed ? "changed" : ""} ${k === "amount" && v.amount === null ? "missing" : ""}`}>
        <label htmlFor={`f-${k}`}>{label}</label>
        <input id={`f-${k}`} className="num" inputMode="numeric" placeholder={ph} value={v[k] ?? ""}
          onChange={(e) => { const t = e.target.value.replace(/[,\s]/g, ""); setV({ ...v, [k]: t === "" || isNaN(+t) ? null : Math.round(+t) }); }} />
        <div className="ai">{changed ? `AI 原本讀到：${ai[k] === null ? "讀不出來" : fmt(ai[k])}` : ""}</div>
      </div>
    );
  };

  async function submit(action: "approve" | "skip") {
    setBusy(true); setErr("");
    const { error } = await sb.rpc("review_receipt", { p_id: row.id, p_action: action, p_values: v, p_summary: summary });
    setBusy(false);
    if (error) return setErr(error.message);
    onDone(action === "approve" ? `已放行：${name} NT$${fmt(v.amount)}` : `已標記不產生收款：${name || v.customer_code}`);
  }

  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      <div className="card">
        <div className="card-head"><h2>單據原圖</h2><span className="sub">{PAGE_TYPE_ZH[page?.page_type ?? ""] ?? ""}｜{row.source}</span></div>
        <PageImage pages={row.pages} />
      </div>
      <div className="card">
        <div className="card-head"><h2>辨識結果</h2><span className="sub">黃底＝已修改，下方保留 AI 原本讀到的值</span></div>
        <form className="form" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (canApprove) submit("approve"); }}>
          <div className="reason warn"><b>{row.reasons.join("、")}</b>{notes && <span>AI 備註：{notes}</span>}</div>
          <div className="fields">
            <div className={`field ${v.customer_code !== ai.customer_code ? "changed" : ""}`}>
              <label htmlFor="f-code">客戶編號</label>
              <input id="f-code" value={v.customer_code} onChange={(e) => setV({ ...v, customer_code: e.target.value.trim() })} />
              <div className="ai">{v.customer_code !== ai.customer_code ? `AI 原本讀到：${ai.customer_code || "讀不出來"}` : ""}</div>
            </div>
            <div className={`field ${name ? "" : "missing"}`}>
              <label htmlFor="f-name">{masterEmpty ? "客戶名稱（客戶主檔尚未匯入，用單據上印的）" : "客戶名稱（依客戶主檔）"}</label>
              <input id="f-name" readOnly value={name || "查無此客戶編號"} />
              <div className="ai">{!name && entry?.customer_name ? `單據上印：${entry.customer_name}` : ""}</div>
            </div>
            {num("printed_total", "印刷合計")}
            {num("corrected_total", "手寫更正後合計", "無")}
            {num("amount", "實收金額", "請對照原圖輸入")}
            {num("remaining", "剩餘未收", "無")}
            <div className={`field ${v.method !== ai.method ? "changed" : ""}`}>
              <label htmlFor="f-method">收款方式</label>
              <select id="f-method" value={v.method} onChange={(e) => setV({ ...v, method: e.target.value as ReceiptValues["method"] })}>
                {(["cash", "check", "transfer", "unknown"] as const).map((m) => <option key={m} value={m}>{METHOD_ZH[m]}</option>)}
              </select>
              <div className="ai">{v.method !== ai.method ? `AI 原本讀到：${METHOD_ZH[ai.method]}` : ""}</div>
            </div>
            {v.method === "check" && (
              <div className={`field ${v.check_number !== ai.check_number ? "changed" : ""}`}>
                <label htmlFor="f-chk">支票號碼</label>
                <input id="f-chk" value={v.check_number ?? ""} onChange={(e) => setV({ ...v, check_number: e.target.value.replace(/\s+/g, "") || null })} />
                <div className="ai">{v.check_number !== ai.check_number ? `AI 原本讀到：${ai.check_number ?? "沒有"}` : ""}</div>
              </div>
            )}
          </div>
          <div className={`field ${(v.note ?? "") !== (ai.note ?? "") ? "changed" : ""}`}>
            <label htmlFor="f-note">附註（會加在摘要最後，例如「扣匯費 18」「退 2 籃扣 60」）</label>
            <input id="f-note" value={v.note ?? ""} onChange={(e) => setV({ ...v, note: e.target.value || undefined })} />
          </div>
          {v.date_corrections.length > 0 && (
            <div className="note">
              日期更改：{v.date_corrections.map((d) => `${d.original} 改 ${d.corrected}`).join("、")}
              <button className="btn small" type="button" style={{ marginLeft: 8 }} onClick={() => setV({ ...v, date_corrections: [] })}>不是日期更改，移除</button>
            </div>
          )}
          <div className="summary"><span>匯出時的「摘要名稱」（依規則自動產生）</span><output>{summary || "（正常，留空）"}</output></div>
          {err && <div className="err">{err}</div>}
          <div className="actions">
            <button className="btn primary" type="submit" disabled={busy || !canApprove}>確認放行</button>
            <button className="btn danger" type="button" disabled={busy} onClick={() => submit("skip")}>不產生收款</button>
            <span className="hint">{!name ? "客戶編號不在主檔，請先修正" : v.amount === null ? "請先輸入實收金額" : "確認後會出現在「匯出收款單」"}</span>
          </div>
        </form>
      </div>
    </div>
  );
}
