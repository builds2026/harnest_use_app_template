"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function AuthForm({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setMessage("");
    if (mode === "signup" && password !== confirm) { setError("비밀번호가 일치하지 않습니다."); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/auth", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, email, password }),
      });
      const value = await response.json() as { error?: string; requiresConfirmation?: boolean };
      if (!response.ok) throw new Error(value.error ?? "인증에 실패했습니다.");
      if (value.requiresConfirmation) {
        setMessage("가입 확인 메일을 보냈습니다. 이메일 인증 후 로그인하세요.");
        setMode("login"); setPassword(""); setConfirm("");
      } else { router.replace("/"); router.refresh(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "인증에 실패했습니다."); }
    finally { setBusy(false); }
  };

  return <main className="auth-page">
    <section className="auth-card" aria-labelledby="auth-title">
      <div className="auth-brand"><span className="mark" aria-hidden="true">⌁</span><strong>arc</strong></div>
      <p className="eyebrow">HARNEST AI WORKSPACE</p>
      <h1 id="auth-title">{mode === "login" ? "다시 오신 것을 환영합니다" : "새 계정 만들기"}</h1>
      <p>{mode === "login" ? "대화와 실행 기록을 계속 이용하려면 로그인하세요." : "이메일 인증 후 모든 Harnest 기능을 사용할 수 있습니다."}</p>
      <div className="auth-switch" role="tablist" aria-label="인증 방식">
        <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => { setMode("login"); setError(""); setMessage(""); }}>로그인</button>
        <button type="button" role="tab" aria-selected={mode === "signup"} onClick={() => { setMode("signup"); setError(""); setMessage(""); }}>회원가입</button>
      </div>
      {!configured && <div className="auth-error" role="alert">Supabase 환경변수를 먼저 설정하세요.</div>}
      {error && <div className="auth-error" role="alert">{error}</div>}
      {message && <div className="auth-success" role="status">{message}</div>}
      <form onSubmit={submit}>
        <label>이메일<input name="email" type="email" autoComplete="email" required maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
        <label>비밀번호<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="8자 이상" /></label>
        {mode === "signup" && <label>비밀번호 확인<input name="confirm" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>}
        <button className="auth-submit" disabled={!configured || busy}>{busy ? "처리 중…" : mode === "login" ? "로그인" : "계정 만들기"}</button>
      </form>
      <small>인증과 사용자 데이터는 Supabase가 관리하며 Harnest는 실행만 처리합니다.</small>
    </section>
  </main>;
}
