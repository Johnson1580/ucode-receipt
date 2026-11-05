// 建立第一個老闆帳號（部署後只需跑一次；之後的帳號由老闆在「系統設定」建立）
// 用法：SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/create_owner.ts <email> <姓名> <初始密碼>
const [email, name, password] = process.argv.slice(2);
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
if (!email || !name || !password || !url || !key) {
  console.error("用法：SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/create_owner.ts <email> <姓名> <初始密碼>");
  process.exit(1);
}
const h = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const u = await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: h, body: JSON.stringify({ email, password, email_confirm: true }) });
const user = await u.json();
if (!u.ok) { console.error("建立帳號失敗", user); process.exit(1); }
const p = await fetch(`${url}/rest/v1/profiles`, { method: "POST", headers: h,
  body: JSON.stringify({ id: user.id, email, display_name: name, roles: ["owner", "accountant", "reviewer"] }) });
if (!p.ok) { console.error("建立角色失敗", await p.text()); process.exit(1); }
console.log(`已建立老闆帳號 ${email}（老闆＋會計＋複核人員）`);
