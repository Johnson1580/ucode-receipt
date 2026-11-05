"use client";
// 系統設定（附件一項目 5）：只有老闆可以使用。參數、客戶主檔、帳號與角色、常駐電腦的裝置金鑰。
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal } from "@/components/Modal";
import { PushToggle } from "@/components/PushToggle";
import { useMe } from "@/components/Shell";
import { useToast } from "@/components/Toast";
import type { Role } from "@/lib/auth";
import { loadCustomers } from "@/lib/data";
import { timeTW } from "@/lib/format";
import { must, useLive } from "@/lib/hooks";
import { can, ROLE_ZH } from "@/lib/roles";
import { supabaseBrowser } from "@/lib/supabase/client";

const ROLES: Role[] = ["owner", "accountant", "reviewer"];

async function api(url: string, method: string, body: unknown) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? "失敗");
  return j;
}

export default function SettingsPage() {
  const me = useMe();
  const owner = can.settings(me.roles);
  return (
    <>
      <div className="page-head"><h1>系統設定</h1><p>{owner ? "我的帳號；其他設定只有老闆（系統管理）可以修改" : "我的帳號"}</p></div>
      <MyAccount />
      {owner && <OwnerSettings />}
    </>
  );
}

function MyAccount() {
  const me = useMe();
  const router = useRouter();
  async function logout() {
    await supabaseBrowser().auth.signOut();
    router.replace("/login");
  }
  return (
    <div className="card">
      <div className="card-head"><h2>我的帳號</h2></div>
      <div className="card-body"><dl className="kv">
        <dt>姓名</dt><dd>{me.display_name}</dd>
        <dt>帳號</dt><dd className="mono">{me.email}</dd>
        <dt>角色</dt><dd>{me.roles.map((r) => ROLE_ZH[r]).join("、")}</dd>
        <dt>手機通知</dt><dd><PushToggle /><div className="hint" style={{ marginTop: 4 }}>每支手機要各自開啟。異常（AI 額度不足、上傳程式沒回報、外接硬碟沒接）與每批辨識完成都會通知。</div></dd>
      </dl>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn" type="button" onClick={() => router.push("/reset-password")}>更改密碼</button>
          <button className="btn" type="button" onClick={logout}>登出</button>
        </div>
      </div>
    </div>
  );
}

function OwnerSettings() {
  return (
    <>
      <div className="grid2"><Params /><Customers /></div>
      <RecognitionMode />
      <Accounts />
      <Devices />
    </>
  );
}

function Params() {
  const sb = supabaseBrowser();
  const toast = useToast();
  const { data, reload } = useLive(async () => must(await sb.from("settings").select("*").single()), [], 0);
  const [f, setF] = useState<Record<string, string>>({});
  if (!data) return <div className="card card-body">載入中…</div>;
  const val = (k: string) => f[k] ?? String(data[k] ?? "");
  async function save() {
    const fee = Number(val("fee"));
    if (!/^\d+$/.test(val("bank_account")) || !/^\d+$/.test(val("subject_code")) || !Number.isInteger(fee)) return toast("存摺帳號、科目編碼要是數字，手續費要是整數");
    const { error } = await sb.from("settings").update({
      bank_account: val("bank_account"), subject_code: val("subject_code"), fee,
      backup_time: val("backup_time").slice(0, 5), uploader_alert_minutes: Number(val("uploader_alert_minutes")) || 30,
      updated_at: new Date().toISOString(), updated_by: (await sb.auth.getUser()).data.user?.id,
    }).eq("id", true);
    if (error) return toast(error.message);
    toast("已儲存，新匯出的收款單會套用新值"); setF({}); reload();
  }
  const input = (k: string, label: string, type = "text") => (
    <div className="field"><label htmlFor={`s-${k}`}>{label}</label>
      <input id={`s-${k}`} type={type} className="num" value={type === "time" ? val(k).slice(0, 5) : val(k)} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>
  );
  return (
    <div className="card">
      <div className="card-head"><h2>參數設定</h2>{data.updated_at && <span className="sub">最近修改 {timeTW(data.updated_at)}</span>}</div>
      <div className="form">
        <div className="fields">
          {input("bank_account", "收款存摺帳號")}
          {input("subject_code", "科目編碼")}
          {input("fee", "手續費")}
          {input("backup_time", "每日備份到外接硬碟的時間", "time")}
          {input("uploader_alert_minutes", "上傳程式幾分鐘沒回報就通知")}
        </div>
        <div className="actions"><button className="btn primary" type="button" onClick={save} disabled={!Object.keys(f).length}>儲存</button>
          <span className="hint">修改後新匯出的收款單套用新值；已匯出的檔案不變。</span></div>
      </div>
    </div>
  );
}

function RecognitionMode() {
  const sb = supabaseBrowser();
  const toast = useToast();
  const { data, reload } = useLive(async () => must(await sb.from("settings").select("recognition_mode").single()), [], 0);
  async function set(mode: "batch" | "realtime") {
    const { error } = await sb.from("settings").update({ recognition_mode: mode, updated_at: new Date().toISOString() }).eq("id", true);
    if (error) return toast(error.message);
    toast(mode === "batch" ? "已改為批次辨識" : "已改為即時辨識"); reload();
  }
  const opt = (mode: "batch" | "realtime", title: string, desc: string) => (
    <label className="chk" style={{ alignItems: "flex-start", display: "flex", gap: 8 }}>
      <input type="radio" name="mode" checked={data?.recognition_mode === mode} onChange={() => set(mode)} style={{ marginTop: 5 }} />
      <span><b>{title}</b><br /><span className="note">{desc}</span></span>
    </label>
  );
  return (
    <div className="card">
      <div className="card-head"><h2>辨識模式</h2><span className="sub">AI 費用由貴公司直接支付給 Google</span></div>
      <div className="form">
        {opt("batch", "批次辨識（目前建議）", "整批送 AI，費用約為即時的一半。通常幾分鐘到 1 小時內完成，最長不超過 24 小時。")}
        {opt("realtime", "即時辨識", "掃完幾分鐘內完成，AI 費用約為批次的兩倍。")}
        <span className="hint">切換後，新掃描的單據套用新模式；已經送出的批次照常完成。</span>
      </div>
    </div>
  );
}

function Customers() {
  const sb = supabaseBrowser();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { data, reload } = useLive(async () => {
    const [c, last] = await Promise.all([
      sb.from("customers").select("code", { count: "exact", head: true }),
      sb.from("customers").select("updated_at").order("updated_at", { ascending: false }).limit(1),
    ]);
    return { count: c.count ?? 0, last: must(last)[0]?.updated_at as string | undefined };
  }, [], 0);
  async function upload(file: File) {
    setBusy(true);
    const fd = new FormData(); fd.append("file", file);
    const res = await fetch("/api/customers/import", { method: "POST", body: fd });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) return toast(j.error);
    toast(`已匯入 ${j.count} 筆客戶${j.warning ? "。" + j.warning : ""}`);
    loadCustomers(true); reload();
  }
  return (
    <div className="card">
      <div className="card-head"><h2>客戶主檔</h2></div>
      <div className="card-body"><dl className="kv">
        <dt>客戶數</dt><dd>{data?.count ?? "…"} 筆</dd>
        <dt>最近更新</dt><dd>{data?.last ? timeTW(data.last) : "尚未匯入"}</dd>
        <dt>用途</dt><dd>匯出時依客戶編號帶出客戶名稱；主檔找不到的客戶編號會進待複核</dd>
      </dl>
        <div className="actions" style={{ marginTop: 12 }}>
          <label className="btn" style={{ cursor: busy ? "wait" : "pointer" }}>{busy ? "匯入中…" : "匯入 Excel"}
            <input type="file" accept=".xlsx" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} /></label>
          <span className="hint">從 ERP 匯出客戶資料（含客戶編號、客戶名稱兩欄），已有的編號會更新名稱。</span>
        </div>
      </div>
    </div>
  );
}

function Accounts() {
  const sb = supabaseBrowser();
  const me = useMe();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: "", display_name: "", password: "", roles: ["reviewer"] as Role[] });
  const { data, reload } = useLive(async () => must(await sb.from("profiles").select("*").order("created_at")), [], 0);
  async function patch(id: string, body: Record<string, unknown>) {
    try { await api("/api/admin/users", "PATCH", { id, ...body }); toast("已更新"); reload(); } catch (e) { toast(String((e as Error).message)); }
  }
  async function create() {
    try { await api("/api/admin/users", "POST", form); toast(`已建立 ${form.display_name} 的帳號`); setAdding(false); setForm({ email: "", display_name: "", password: "", roles: ["reviewer"] }); reload(); }
    catch (e) { toast(String((e as Error).message)); }
  }
  return (
    <div className="card">
      <div className="card-head"><h2>帳號與權限</h2><span className="sub">一個帳號可以兼任多個角色</span>
        <div className="right"><button className="btn small" type="button" onClick={() => setAdding(true)}>新增帳號</button></div></div>
      <div className="tbl-wrap"><table className="tbl">
        <thead><tr><th>姓名</th><th>電子郵件</th><th>角色</th><th>狀態</th><th></th></tr></thead>
        <tbody>{data?.map((p) => (
          <tr key={p.id}>
            <td>{p.display_name}</td><td className="mono">{p.email}</td>
            <td>{ROLES.map((r) => (
              <label key={r} className="chk" style={{ marginRight: 10 }}>
                <input type="checkbox" checked={p.roles.includes(r)} disabled={!p.active}
                  onChange={(e) => patch(p.id, { roles: e.target.checked ? [...p.roles, r] : p.roles.filter((x: string) => x !== r) })} />{ROLE_ZH[r]}</label>))}</td>
            <td>{p.active ? <span className="chip ok">啟用</span> : <span className="chip mute">已停用</span>}</td>
            <td>{p.id !== me.id && <button className="btn small danger" type="button" onClick={() => patch(p.id, { active: !p.active })}>{p.active ? "停用" : "重新啟用"}</button>}</td>
          </tr>))}</tbody>
      </table></div>
      {adding && (
        <Modal title="新增帳號" onClose={() => setAdding(false)}>
          <div className="form">
            <div className="fields">
              <div className="field"><label htmlFor="n-name">姓名</label><input id="n-name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></div>
              <div className="field"><label htmlFor="n-email">電子郵件（登入帳號）</label><input id="n-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
              <div className="field"><label htmlFor="n-pw">初始密碼（至少 8 字元，請本人登入後自行更改）</label><input id="n-pw" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
            </div>
            <div>{ROLES.map((r) => (
              <label key={r} className="chk" style={{ marginRight: 14 }}><input type="checkbox" checked={form.roles.includes(r)}
                onChange={(e) => setForm({ ...form, roles: e.target.checked ? [...form.roles, r] : form.roles.filter((x) => x !== r) })} />{ROLE_ZH[r]}</label>))}</div>
            <div className="actions"><button className="btn primary" type="button" onClick={create}>建立</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Devices() {
  const sb = supabaseBrowser();
  const toast = useToast();
  const [token, setToken] = useState<string | null>(null);
  const { data, reload } = useLive(async () => must(await sb.from("devices").select("*").order("created_at")), [], 30_000);
  async function create(kind: "uploader" | "backup") {
    const name = prompt(kind === "uploader" ? "這台電腦的名稱（例：櫃台電腦）" : "備份用金鑰的名稱（例：櫃台電腦備份）");
    if (!name) return;
    try { setToken((await api("/api/admin/devices", "POST", { name, kind })).token); reload(); } catch (e) { toast(String((e as Error).message)); }
  }
  async function toggle(id: string, active: boolean) {
    try { await api("/api/admin/devices", "PATCH", { id, active }); reload(); } catch (e) { toast(String((e as Error).message)); }
  }
  return (
    <div className="card">
      <div className="card-head"><h2>常駐電腦與資料備份</h2>
        <div className="right"><button className="btn small" type="button" onClick={() => create("uploader")}>新增上傳金鑰</button>
          <button className="btn small" type="button" onClick={() => create("backup")}>新增備份金鑰</button></div></div>
      <div className="tbl-wrap"><table className="tbl">
        <thead><tr><th>名稱</th><th>用途</th><th>最近回報</th><th>外接硬碟</th><th>狀態</th><th></th></tr></thead>
        <tbody>{data?.map((d) => (
          <tr key={d.id}>
            <td>{d.name}</td><td>{d.kind === "uploader" ? "上傳掃描檔（只能上傳）" : "每日備份（只能讀取）"}</td>
            <td>{d.last_seen_at ? timeTW(d.last_seen_at) : "—"}</td>
            <td>{d.kind !== "uploader" ? "—" : d.last_status?.hdd_connected === false ? <span className="chip crit">未連接</span> : d.last_status?.hdd_connected ? <span className="chip ok">已連接</span> : "—"}</td>
            <td>{d.active ? <span className="chip ok">啟用</span> : <span className="chip mute">已停用</span>}</td>
            <td><button className="btn small danger" type="button" onClick={() => toggle(d.id, !d.active)}>{d.active ? "停用" : "重新啟用"}</button></td>
          </tr>))}
          {data && !data.length && <tr><td colSpan={6} className="empty">還沒有裝置。到場安裝上傳程式時建立。</td></tr>}</tbody>
      </table></div>
      <div className="card-body note">雲端原圖保存 90 天後自動刪除（收款與複核紀錄不刪）。上傳成功的掃描檔與每日收款資料會備份到常駐電腦的外接硬碟，保存期間由貴公司自行決定。電腦遺失或更換時，按「停用」讓舊金鑰失效。</div>
      {token && (
        <Modal title="金鑰（只會顯示這一次）" onClose={() => setToken(null)}>
          <div className="form">
            <p className="note">請複製到常駐電腦的上傳程式設定檔。關閉這個視窗後就看不到了，遺失只能停用後重新建立。</p>
            <input className="inp num" readOnly value={token} onFocus={(e) => e.target.select()} />
            <div className="actions"><button className="btn primary" type="button" onClick={() => navigator.clipboard.writeText(token).then(() => toast("已複製"))}>複製</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}
