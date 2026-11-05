"use client";
// 忘記密碼信件的連結，以及登入後在「系統設定 → 我的帳號 → 更改密碼」都用這一頁
import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw.length < 8) return setErr("密碼至少 8 個字元。");
    if (pw !== pw2) return setErr("兩次輸入的密碼不一樣。");
    setBusy(true);
    const { error } = await supabaseBrowser().auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return setErr("儲存失敗：信件連結可能已過期，或登入已失效，請回登入頁重新登入或申請。");
    router.replace("/");
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="card-head"><h2>設定新密碼</h2></div>
        <div className="form">
          <div className="field"><label htmlFor="pw">新密碼</label><input id="pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
          <div className="field"><label htmlFor="pw2">再輸入一次</label><input id="pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
          {err && <div className="err">{err}</div>}
          <div className="actions"><button className="btn primary" type="submit" disabled={busy}>儲存新密碼</button>
            <button className="btn" type="button" onClick={() => router.replace("/")}>取消</button></div>
        </div>
      </form>
    </div>
  );
}
