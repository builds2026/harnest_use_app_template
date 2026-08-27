"use client";

import Link from "next/link";
import { useLocale } from "./locale-context";
import styles from "./route-state.module.css";

const copyFor = (locale: "en-US" | "ko-KR") => locale === "ko-KR" ? {
  loadingTitle: "워크스페이스를 준비하고 있어요",
  loadingBody: "대화와 실행 상태를 안전하게 불러오는 중입니다.",
  errorTitle: "화면을 불러오지 못했어요",
  errorBody: "잠시 후 다시 시도하세요. 문제가 계속되면 진단 ID로 서버 로그를 확인할 수 있습니다.",
  missingTitle: "이 화면을 찾을 수 없어요",
  missingBody: "주소가 바뀌었거나 더 이상 제공되지 않는 화면입니다.",
  back: "워크스페이스로 돌아가기",
  retry: "다시 시도",
} : {
  loadingTitle: "Preparing your workspace",
  loadingBody: "Loading conversations and durable run state.",
  errorTitle: "This screen could not be loaded",
  errorBody: "Try again in a moment. If it continues, use the diagnostic ID to find the server log.",
  missingTitle: "This screen does not exist",
  missingBody: "The address may have changed or the screen is no longer available.",
  back: "Back to workspace",
  retry: "Try again",
};

function Frame({ mark, title, body, animated = false, children }: {
  mark: string;
  title: string;
  body: string;
  animated?: boolean;
  children?: React.ReactNode;
}) {
  return <main className={styles.page}>
    <section className={styles.card}>
      <span className={`${styles.mark} ${animated ? styles.animated : ""}`} aria-hidden="true">{mark}</span>
      <h1>{title}</h1>
      <p>{body}</p>
      {children && <div className={styles.actions}>{children}</div>}
    </section>
  </main>;
}

export function RouteLoading() {
  const { locale } = useLocale();
  const copy = copyFor(locale);
  return <div role="status" aria-live="polite"><Frame mark="…" title={copy.loadingTitle} body={copy.loadingBody} animated /></div>;
}

export function RouteError({ digest, onRetry }: { digest?: string; onRetry: () => void }) {
  const { locale } = useLocale();
  const copy = copyFor(locale);
  return <Frame mark="!" title={copy.errorTitle} body={copy.errorBody}>
    <button className={styles.primaryAction} type="button" onClick={onRetry}>{copy.retry}</button>
    <Link className={styles.secondaryAction} href="/">{copy.back}</Link>
    {digest && <code className={styles.digest}>{digest}</code>}
  </Frame>;
}

export function RouteNotFound() {
  const { locale } = useLocale();
  const copy = copyFor(locale);
  return <Frame mark="404" title={copy.missingTitle} body={copy.missingBody}>
    <Link className={styles.primaryAction} href="/">{copy.back}</Link>
  </Frame>;
}
