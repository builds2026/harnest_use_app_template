"use client";

import { Form } from "@base-ui/react/form";
import { Tabs } from "@base-ui/react/tabs";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LocaleSwitch, ThemeSwitch, useLocale } from "@/components/locale-context";

export function AuthForm({ configured, autoConfirm }: { configured: boolean; autoConfirm: boolean }) {
  const router = useRouter();
  const { t } = useLocale();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const submit = async () => {
    setError(""); setMessage("");
    if (mode === "signup" && password !== confirm) { setError(t("auth.passwordMismatch")); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/auth", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, email, password }),
      });
      const value = await response.json() as { error?: string; requiresConfirmation?: boolean };
      if (!response.ok) throw new Error(value.error ?? t("auth.failed"));
      if (value.requiresConfirmation) {
        setMessage(t("auth.checkEmail"));
        setMode("login"); setPassword(""); setConfirm("");
      } else { router.replace("/"); router.refresh(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("auth.failed")); }
    finally { setBusy(false); }
  };

  return <main className="auth-page">
    <section className="auth-intro" aria-label={t("auth.heroEyebrow")}>
      <div className="auth-intro-mark" aria-hidden="true">⌁</div>
      <p className="eyebrow">{t("auth.heroEyebrow")}</p>
      <h2>{t("auth.heroTitle")}</h2>
      <p>{t("auth.heroBody")}</p>
      <span>{t("auth.heroProof")}</span>
    </section>
    <section className="auth-card" aria-labelledby="auth-title">
      <div className="auth-brand"><span className="mark" aria-hidden="true">⌁</span><strong>arc</strong><span className="auth-preferences"><ThemeSwitch /><LocaleSwitch /></span></div>
      <p className="eyebrow">HARNEST AI WORKSPACE</p>
      <h1 id="auth-title">{t(mode === "login" ? "auth.welcome" : "auth.create")}</h1>
      <p>{t(mode === "login" ? "auth.loginIntro" : autoConfirm ? "auth.autoConfirm" : "auth.confirmEmail")}</p>
      <Tabs.Root value={mode} onValueChange={(value) => { if (value === "login" || value === "signup") { setMode(value); setError(""); setMessage(""); } }}><Tabs.List className="auth-switch" aria-label={t("auth.mode")}><Tabs.Tab value="login">{t("auth.signIn")}</Tabs.Tab><Tabs.Tab value="signup">{t("auth.signUp")}</Tabs.Tab></Tabs.List></Tabs.Root>
      {!configured && <div className="auth-error" role="alert">{t("auth.configure")}</div>}
      {error && <div className="auth-error" role="alert">{error}</div>}
      {message && <div className="auth-success" role="status">{message}</div>}
      <Form validationMode="onBlur" onFormSubmit={() => void submit()}>
        <label>{t("auth.email")}<input name="email" type="email" autoComplete="email" required maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
        <label>{t("auth.password")}<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("auth.passwordHint")} /></label>
        {mode === "signup" && <label>{t("auth.confirmPassword")}<input name="confirm" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>}
        <button className="auth-submit" disabled={!configured || busy}>{busy ? t("auth.working") : t(mode === "login" ? "auth.signIn" : "auth.createAccount")}</button>
      </Form>
      <small>{t("auth.boundary")}</small>
    </section>
  </main>;
}
