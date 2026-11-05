// 每日維護（排程呼叫）：
// 1. 原始掃描影像保存 90 天，逾期自動刪除（合約第十一條第 6 項）；辨識結果、收款與複核紀錄不刪
// 2. 上傳程式超過設定時間沒回報 → 通知（只在白天 7～20 點提醒，晚上關機是正常的）
// 每 10 分鐘呼叫一次也沒關係，刪除與檢查都是冪等的。

import { json, notify, resolve, sendPendingNotifications, serviceClient, taipeiHour } from "../_shared/db.ts";

const RETENTION_DAYS = 90;

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return json({ error: "unauthorized" }, 401);
  // 通過驗證後才把錯誤內容回傳（排程呼叫的回應會留在 net._http_response，方便查問題）
  try { return await run(req); } catch (e) { console.error(e); const err = e as Error; return json({ error: String(err?.message ?? e), stack: String(err?.stack ?? "").slice(0, 800) }, 500); }
});

async function run(req: Request): Promise<Response> {
  const sb = serviceClient();
  const body = await req.json().catch(() => ({}));
  // 部署後跑一次：把排程需要的專案網址與排程密鑰寫進 vault（密鑰來自本程式的環境變數）
  if (body.setup) {
    const { error } = await sb.rpc("setup_cron_secrets", { p_url: Deno.env.get("SUPABASE_URL"), p_secret: Deno.env.get("CRON_SECRET") });
    if (error) throw error;
  }
  // 部署後建立第一個老闆帳號（只有在還沒有老闆時可以用）。密碼隨機產生、不回傳，老闆用登入頁「忘記密碼」自己設定。
  if (body.create_owner) {
    const { email, name } = body.create_owner;
    const { count } = await sb.from("profiles").select("id", { count: "exact", head: true }).contains("roles", ["owner"]);
    if (count) return json({ error: "已經有老闆帳號，之後的帳號請老闆在系統設定建立" }, 400);
    const { data, error } = await sb.auth.admin.createUser({ email, password: crypto.randomUUID() + crypto.randomUUID(), email_confirm: true });
    if (error) throw error;
    const ins = await sb.from("profiles").insert({ id: data.user.id, email, display_name: name, roles: ["owner"] });
    if (ins.error) { await sb.auth.admin.deleteUser(data.user.id); throw ins.error; }
    return json({ ok: true, email, name });
  }
  // 乙方建立帳號（測試帳號等；平常由老闆在系統設定建立）。密碼由呼叫端提供，不回傳。
  if (body.create_account) {
    const { email, name, roles, password } = body.create_account;
    const okRoles = (roles ?? []).filter((r: string) => ["owner", "accountant", "reviewer"].includes(r));
    if (!email || !name || !okRoles.length || !password || password.length < 12) return json({ error: "參數錯誤" }, 400);
    const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    const ins = await sb.from("profiles").insert({ id: data.user.id, email, display_name: name, roles: okRoles });
    if (ins.error) { await sb.auth.admin.deleteUser(data.user.id); throw ins.error; }
    return json({ ok: true, email, name, roles: okRoles });
  }
  // 乙方修改既有帳號（改用途、改名稱／角色、設臨時密碼）。只改有傳的欄位，密碼不回傳。
  if (body.update_account) {
    const { email, name, roles, password } = body.update_account;
    const { data: p } = await sb.from("profiles").select("id").eq("email", email).maybeSingle();
    if (!p) return json({ error: "找不到這個帳號" }, 404);
    const patch: Record<string, unknown> = {};
    if (name) patch.display_name = name;
    if (roles) {
      patch.roles = (roles as string[]).filter((r) => ["owner", "accountant", "reviewer"].includes(r));
      if (!(patch.roles as string[]).length) return json({ error: "參數錯誤" }, 400);
    }
    if (password !== undefined) {
      if (typeof password !== "string" || password.length < 8) return json({ error: "密碼至少 8 碼" }, 400);
      const { error } = await sb.auth.admin.updateUserById(p.id, { password });
      if (error) throw error;
    }
    if (Object.keys(patch).length) {
      const { error } = await sb.from("profiles").update(patch).eq("id", p.id);
      if (error) throw error;
    }
    const { data: after } = await sb.from("profiles").select("email, display_name, roles, active").eq("id", p.id).single();
    return json({ ok: true, ...after, password_changed: password !== undefined });
  }
  // 乙方查客戶主檔（核對辨識出的編號用）：名稱或編號包含關鍵字的前 30 筆
  if (body.find_customer) {
    const q = String(body.find_customer);
    const { data, error } = await sb.from("customers").select("code, name").or(`name.ilike.%${q}%,code.ilike.%${q}%`).order("code").limit(30);
    if (error) throw error;
    return json({ customers: data });
  }
  // 上線前清除測試資料（有任何匯出紀錄就拒絕，正式上線後無法使用）
  if (body.reset_test_data === "刪除所有測試資料") {
    const { count } = await sb.from("exports").select("id", { count: "exact", head: true });
    if (count) return json({ error: "已經有匯出紀錄，不能清除" }, 400);
    const { data: ups } = await sb.from("uploads").select("id");
    for (const u of ups ?? []) {
      const { data: objs } = await sb.storage.from("scans").list(u.id, { limit: 2000 });
      if (objs?.length) await sb.storage.from("scans").remove(objs.map((o) => `${u.id}/${o.name}`));
    }
    for (const t of ["review_logs", "receipts", "other_records", "pages", "ai_batches", "uploads", "notifications"]) {
      const { error } = await sb.from(t).delete().not("created_at", "is", null);
      if (error) throw new Error(`${t}: ${error.message}`);
    }
    return json({ ok: true, uploads: ups?.length ?? 0 });
  }
  if (body.setup || body.status) {
    const { data, error } = await sb.rpc("cron_status");
    if (error) throw error;
    // 處理進度（只有筆數，不含客戶資料）
    const count = async (table: string, col: string) => {
      const { data: rows } = await sb.from(table).select(col);
      const m: Record<string, number> = {};
      for (const r of (rows ?? []) as unknown as Record<string, string>[]) m[r[col]] = (m[r[col]] ?? 0) + 1;
      return m;
    };
    const progress = { uploads: await count("uploads", "status"), pages: await count("pages", "status"),
      receipts: await count("receipts", "status"), other_records: await count("other_records", "category"),
      batches: await count("ai_batches", "state") };
    const { data: failed } = await sb.from("pages").select("page_no, error, uploads(file_name)").eq("status", "failed").limit(20);
    // 雲端實際還留著的檔案數（翻轉圖用完應該都刪掉了）
    const files = { originals: 0, mirrors: 0 };
    const { data: ups } = await sb.from("uploads").select("id").order("created_at", { ascending: false }).limit(20);
    for (const u of ups ?? []) {
      const { data: objs } = await sb.storage.from("scans").list(u.id, { limit: 2000 });
      for (const o of objs ?? []) o.name.endsWith("_m.jpg") ? files.mirrors++ : files.originals++;
    }
    // 其他單據紀錄的來源頁與類別（核對透字判斷用，不含內容）
    const { data: otherList } = await sb.from("other_records").select("source, category").order("created_at", { ascending: false }).limit(50);
    // 每批上傳（清測試資料前確認哪些是現場正式掃描的）
    const { data: uploadList } = await sb.from("uploads").select("file_name, page_count, status, created_at, devices(name)").order("created_at").limit(100);
    const { count: exportCount } = await sb.from("exports").select("id", { count: "exact", head: true });
    // 客戶主檔概況（只有編號格式統計，不含名稱）與已辨識收款的客戶編號對得上幾筆
    const codes: string[] = [];
    for (let from = 0; ; from += 1000) {
      const { data: cs } = await sb.from("customers").select("code").range(from, from + 999);
      codes.push(...(cs ?? []).map((c) => c.code));
      if (!cs || cs.length < 1000) break;
    }
    const master = new Set(codes);
    const shape = (c: string) => c.replace(/\d/g, "9").replace(/[A-Za-z]/g, "A");
    const shapes: Record<string, number> = {};
    for (const c of codes) shapes[shape(c)] = (shapes[shape(c)] ?? 0) + 1;
    const { data: rcs } = await sb.from("receipts").select("customer_code, customer_name, status, page_ids").limit(2000);
    const rCodes = (rcs ?? []).map((r) => r.customer_code as string).filter(Boolean);
    const missing = [...new Set(rCodes.filter((c) => !master.has(c)))];
    const customers = { count: codes.length, code_shapes: shapes, samples: codes.slice(0, 5),
      receipts_matched: rCodes.length - rCodes.filter((c) => !master.has(c)).length, receipts_total: rCodes.length, missing_codes: missing.slice(0, 30).map((c) => ({ code: c, similar: codes.filter((m) => m.split("-")[0] === c.split("-")[0]).slice(0, 10),
        receipts: (rcs ?? []).filter((r) => r.customer_code === c).map((r) => ({ name: r.customer_name, status: r.status, pages: r.page_ids })) })) };
    return json({ ...data, progress, failed, files_in_recent_uploads: files, other_records: otherList, customers, uploads: uploadList, exports: exportCount });
  }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
  let deleted = 0;
  for (let round = 0; round < 20; round++) {
    const { data: pages } = await sb.from("pages").select("id, image_path").is("image_deleted_at", null)
      .lt("created_at", cutoff).limit(500);
    if (!pages?.length) break;
    const { error } = await sb.storage.from("scans").remove(pages.flatMap((p) => [p.image_path, p.image_path.replace(/\.jpg$/, "_m.jpg")])); // 翻轉圖通常早已刪除，一併帶上保險
    if (error) throw error;
    await sb.from("pages").update({ image_deleted_at: new Date().toISOString() }).in("id", pages.map((p) => p.id));
    deleted += pages.length;
  }


  // 補刪遺留的翻轉圖（辨識程式中斷時可能沒刪到）：已結束超過 1 小時的頁面
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  for (let round = 0; round < 10; round++) {
    const { data: pages } = await sb.from("pages").select("id, image_path").is("mirror_deleted_at", null)
      .in("status", ["done", "failed"]).lt("processed_at", hourAgo).limit(500);
    if (!pages?.length) break;
    const { error } = await sb.storage.from("scans").remove(pages.map((p) => p.image_path.replace(/\.jpg$/, "_m.jpg")));
    if (error) throw error;
    await sb.from("pages").update({ mirror_deleted_at: new Date().toISOString() }).in("id", pages.map((p) => p.id));
  }

  // 已停用的裝置不再提醒：把它們還沒解決的「沒回報」「外接硬碟」通知關掉
  const { data: inactive } = await sb.from("devices").select("id").eq("active", false);
  for (const d of inactive ?? []) {
    await resolve(sb, `uploader_offline:${d.id}`);
    await resolve(sb, `hdd:${d.id}`);
  }

  const hour = taipeiHour();
  if (hour >= 7 && hour < 20) {
    const { data } = await sb.from("settings").select("uploader_alert_minutes").single();
    const s = { uploader_alert_minutes: data?.uploader_alert_minutes ?? 30 };
    const limit = new Date(Date.now() - s.uploader_alert_minutes * 60_000).toISOString();
    const { data: stale } = await sb.from("devices").select("id, name, last_seen_at").eq("kind", "uploader").eq("active", true)
      .or(`last_seen_at.lt.${limit},last_seen_at.is.null`);
    for (const d of stale ?? []) {
      await notify(sb, `uploader_offline:${d.id}`,
        `上傳程式「${d.name}」已超過 ${s.uploader_alert_minutes} 分鐘沒有回報，請確認常駐電腦是否開機、連網。`);
    }
  }

  await sendPendingNotifications(sb);
  return json({ deleted });
}
