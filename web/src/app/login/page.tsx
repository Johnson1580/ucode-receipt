"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

function LoginForm() {
  const router = useRouter();
  const q = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(q.get("disabled") ? "這個帳號已停用，請洽老闆。" : q.get("link") ? "連結已失效，請重新申請。" : "");
  const [sent, setSent] = useState(false);
  const [show, setShow] = useState(false);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const { error } = await supabaseBrowser().auth.signInWithPassword({ email: email.trim().toLowerCase(), password: password.trim() });
    setBusy(false);
    if (error) {
      // 只有真的帳密不對才說帳密錯；其他（網路、設定）顯示實際原因，方便排查
      if (/banned/i.test(error.message)) return setErr("這個帳號已停用，請洽老闆。");
      if (/invalid login credentials/i.test(error.message)) return setErr("帳號或密碼錯誤（密碼有分大小寫，可以勾「顯示密碼」確認）。");
      return setErr(`登入失敗：${error.message}`);
    }
    router.replace("/");
    router.refresh();
  }

  async function forgot() {
    if (!email.trim()) return setErr("請先輸入電子郵件，再按「忘記密碼」。");
    setBusy(true); setErr("");
    const { error } = await supabaseBrowser().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${location.origin}/auth/callback?next=/reset-password`,
    });
    setBusy(false);
    if (error) return setErr("寄送失敗，請稍後再試。");
    setSent(true);
  }

  return (
    <div className="login">
      <form className="card" onSubmit={login}>
        <div className="login-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="優碼數位" width={180} height={180} /><h2>AI 收款單據辨識系統</h2>
        </div>
        <div className="form">
          <div className="field"><label htmlFor="email">電子郵件</label>
            <input id="email" type="email" autoComplete="username" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div className="field"><label htmlFor="pw">密碼</label>
            <input id="pw" type={show ? "text" : "password"} autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              value={password} onChange={(e) => setPassword(e.target.value)} />
            <label className="chk"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />顯示密碼</label></div>
          {err && <div className="err">{err}</div>}
          {sent && <div className="note">已寄出重設密碼的信，請到信箱點連結。</div>}
          <div className="actions">
            <button className="btn primary" type="submit" disabled={busy}>登入</button>
            <button className="btn" type="button" onClick={forgot} disabled={busy}>忘記密碼</button>
          </div>
        </div>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
