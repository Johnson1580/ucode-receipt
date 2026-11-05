// 常駐電腦程式用的 API（用裝置金鑰驗證，不用帳號密碼）。
//   上傳金鑰（uploader）：只能上傳掃描檔、回報狀態
//   備份金鑰（backup）  ：只能讀取每日收款資料（下載到外接硬碟）
// 路徑：
//   POST /device-api/upload/start   {file_name, file_hash, page_count}   → 每頁的上傳網址（同檔重複上傳回 duplicate）
//   POST /device-api/upload/finish  {upload_id}                          → 排入辨識
//   POST /device-api/heartbeat      {status}                             → 上傳程式狀態（含外接硬碟是否連接）
//   GET  /device-api/backup/daily?date=20261016                         → 當日收款紀錄、複核修正紀錄、收款單（xlsx，base64）

import { buildReceiptLogXlsx, buildReceiptXlsx, buildReviewLogXlsx } from "../_shared/excel.ts";
import { json, notify, resolve, serviceClient, sha256, taipeiDate } from "../_shared/db.ts";

const PAGE_PATH = (uploadId: string, n: number) => `${uploadId}/p${String(n).padStart(3, "0")}.jpg`;
const MIRROR_PATH = (uploadId: string, n: number) => `${uploadId}/p${String(n).padStart(3, "0")}_m.jpg`; // 左右翻轉圖（透字判斷用）
const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

Deno.serve(async (req) => {
  const sb = serviceClient();
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "缺少裝置金鑰" }, 401);
  const { data: device } = await sb.from("devices").select("*").eq("token_hash", await sha256(token)).maybeSingle();
  if (!device || !device.active) return json({ error: "裝置金鑰無效或已停用" }, 401);
  const route = new URL(req.url).pathname.replace(/^.*\/device-api/, "");
  const need = (kind: string) => device.kind !== kind ? json({ error: "這把金鑰沒有這個權限" }, 403) : null;

  if (route === "/heartbeat" && req.method === "POST") {
    const denied = need("uploader"); if (denied) return denied;
    const { status } = await req.json();
    await sb.from("devices").update({ last_seen_at: new Date().toISOString(), last_status: status }).eq("id", device.id);
    await resolve(sb, `uploader_offline:${device.id}`);
    if (status?.hdd_connected === false) {
      await notify(sb, `hdd:${device.id}`, `「${device.name}」偵測不到外接硬碟，掃描檔與收款資料暫時無法備份。接回後會自動補齊。`);
    } else if (status?.hdd_connected === true) {
      await resolve(sb, `hdd:${device.id}`);
    }
    const { data: s } = await sb.from("settings").select("backup_time").single();
    return json({ ok: true, backup_time: String(s?.backup_time ?? "22:00").slice(0, 5) });
  }

  // 上傳程式自動更新：回傳最新版本與 10 分鐘有效的下載網址（exe 放在 uploader bucket，由 scripts/publish_uploader.sh 上傳）
  if (route === "/uploader/latest" && req.method === "GET") {
    const denied = need("uploader"); if (denied) return denied;
    const { data: f } = await sb.storage.from("uploader").download("latest.json");
    if (!f) return json({ version: null });
    const m = JSON.parse(await f.text()) as { version: string; sha256: string; file: string };
    const { data: u, error } = await sb.storage.from("uploader").createSignedUrl(m.file, 600);
    if (error) return json({ error: error.message }, 500);
    return json({ version: m.version, sha256: m.sha256, url: u.signedUrl });
  }

  if (route === "/upload/start" && req.method === "POST") {
    const denied = need("uploader"); if (denied) return denied;
    const { file_name, file_hash, page_count } = await req.json();
    if (!file_name || !/^[0-9a-f]{64}$/.test(file_hash) || !(page_count > 0 && page_count <= 1000)) {
      return json({ error: "參數錯誤" }, 400);
    }
    let { data: up } = await sb.from("uploads").select("*").eq("file_hash", file_hash).maybeSingle();
    if (up && up.status !== "uploading") return json({ duplicate: true, upload_id: up.id });
    if (!up) {
      const ins = await sb.from("uploads").insert({ device_id: device.id, file_name, file_hash, page_count, scan_date: taipeiDate() })
        .select().single();
      if (ins.error) return json({ error: ins.error.message }, 500);
      up = ins.data;
    }
    const urls = [];
    for (let n = 1; n <= up.page_count; n++) {
      const a = await sb.storage.from("scans").createSignedUploadUrl(PAGE_PATH(up.id, n), { upsert: true });
      const m = await sb.storage.from("scans").createSignedUploadUrl(MIRROR_PATH(up.id, n), { upsert: true });
      if (a.error || m.error) return json({ error: (a.error ?? m.error)!.message }, 500);
      urls.push({ page_no: n, url: a.data.signedUrl, mirror_url: m.data.signedUrl });
    }
    return json({ upload_id: up.id, pages: urls });
  }

  if (route === "/upload/finish" && req.method === "POST") {
    const denied = need("uploader"); if (denied) return denied;
    const { upload_id } = await req.json();
    const { data: up } = await sb.from("uploads").select("*").eq("id", upload_id).eq("device_id", device.id).maybeSingle();
    if (!up) return json({ error: "找不到這個上傳" }, 404);
    if (up.status !== "uploading") return json({ ok: true, already: true });
    const { data: objs } = await sb.storage.from("scans").list(up.id, { limit: 1000 });
    const have = new Set((objs ?? []).map((o) => `${up.id}/${o.name}`));
    const missing = Array.from({ length: up.page_count }, (_, i) => [PAGE_PATH(up.id, i + 1), MIRROR_PATH(up.id, i + 1)]).flat()
      .filter((p) => !have.has(p));
    if (missing.length) return json({ error: `還有 ${missing.length} 頁沒有上傳完成`, missing }, 409);
    const { error } = await sb.from("pages").upsert(
      Array.from({ length: up.page_count }, (_, i) => ({ upload_id: up.id, page_no: i + 1, image_path: PAGE_PATH(up.id, i + 1) })),
      { onConflict: "upload_id,page_no", ignoreDuplicates: true });
    if (error) return json({ error: error.message }, 500);
    await sb.from("uploads").update({ status: "queued" }).eq("id", up.id);
    // 立刻開始辨識（不等下一次排程）
    const url = Deno.env.get("SUPABASE_URL") + "/functions/v1/process-queue";
    const kick = fetch(url, { method: "POST", headers: { "x-cron-secret": Deno.env.get("CRON_SECRET")! } }).catch(() => {});
    // @ts-ignore EdgeRuntime 是 Supabase 執行環境提供的
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(kick);
    return json({ ok: true });
  }

  if (route === "/backup/daily" && req.method === "GET") {
    const denied = need("backup"); if (denied) return denied;
    const date = Number(new URL(req.url).searchParams.get("date") ?? taipeiDate());
    const { data: receipts } = await sb.from("receipts").select("*").eq("scan_date", date).order("created_at");
    const start = `${String(date).slice(0, 4)}-${String(date).slice(4, 6)}-${String(date).slice(6)}T00:00:00+08:00`;
    const end = new Date(new Date(start).getTime() + 86400_000).toISOString();
    const { data: logs } = await sb.from("review_logs").select("*, receipts(customer_code, customer_name), profiles(display_name)")
      .gte("created_at", start).lt("created_at", end).order("created_at");
    const { data: exps } = await sb.from("exports").select("*").gte("created_at", start).lt("created_at", end).order("created_at");
    const files = [
      { name: `收款紀錄_${date}.xlsx`, data: b64(await buildReceiptLogXlsx(receipts ?? [])) },
      { name: `複核修正紀錄_${date}.xlsx`, data: b64(await buildReviewLogXlsx(logs ?? [])) },
    ];
    for (const e of exps ?? []) {
      files.push({ name: e.file_name, data: b64(await buildReceiptXlsx(e.export_date, e.rows, e.settings)) });
    }
    return json({ date, files });
  }

  return json({ error: "not found" }, 404);
});
