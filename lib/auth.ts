export type AuthMode = "login" | "signup";

export function authInput(value: unknown): { mode: AuthMode; email: string; password: string } | { error: string } {
  if (!value || typeof value !== "object") return { error: "요청 형식이 올바르지 않습니다." };
  const body = value as Record<string, unknown>;
  const mode = body.mode;
  const email = typeof body.email === "string" ? body.email.trim().toLocaleLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if ((mode !== "login" && mode !== "signup") || email.length > 320 || !/^\S+@\S+\.\S+$/u.test(email)) return { error: "올바른 이메일 주소를 입력하세요." };
  if (password.length < 8 || password.length > 128) return { error: "비밀번호는 8~128자로 입력하세요." };
  return { mode, email, password };
}

export function signupError(code?: string, message?: string): string {
  if (code === "over_email_send_rate_limit" || /email rate limit/iu.test(message ?? "")) return "이메일 발송 한도를 초과했습니다. 잠시 후 다시 시도하거나 Supabase에 SMTP를 연결하세요.";
  if (code === "weak_password") return "더 안전한 비밀번호를 입력하세요.";
  return message ?? "회원가입에 실패했습니다.";
}
