import { createSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { authInput, signupError } from "@/lib/auth";

export const runtime = "nodejs";

async function confirmTestUser(email: string): Promise<"confirmed" | "existing" | "missing"> {
  const admin = createSupabaseAdmin();
  // ponytail: test-only linear lookup; replace with verified email flow before real users or scale.
  for (let page = 1; ; page += 1) {
    const result = await admin.auth.admin.listUsers({ page, perPage: 1_000 });
    if (result.error) throw result.error;
    const user = result.data.users.find((candidate) => candidate.email?.toLocaleLowerCase() === email);
    if (user) {
      if (user.email_confirmed_at) return "existing";
      const updated = await admin.auth.admin.updateUserById(user.id, { email_confirm: true });
      if (updated.error) throw updated.error;
      return "confirmed";
    }
    if (result.data.users.length < 1_000) return "missing";
  }
}

export async function POST(request: Request) {
  if (!supabaseConfigured()) return Response.json({ error: "Supabase 환경변수가 설정되지 않았습니다." }, { status: 503 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 }); }
  const input = authInput(body);
  if ("error" in input) return Response.json(input, { status: 400 });
  const { mode, email, password } = input;

  const supabase = await createSupabaseServer();
  if (mode === "login") {
    let result = await supabase.auth.signInWithPassword({ email, password });
    if (result.error?.code === "email_not_confirmed" && process.env.AUTH_AUTO_CONFIRM === "true") {
      await confirmTestUser(email);
      result = await supabase.auth.signInWithPassword({ email, password });
    }
    if (result.error) return Response.json({ error: "이메일 또는 비밀번호를 확인하세요." }, { status: 401 });
    return Response.json({ ok: true });
  }

  if (process.env.AUTH_AUTO_CONFIRM === "true") {
    const admin = createSupabaseAdmin();
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) {
      const existing = await confirmTestUser(email);
      if (existing !== "confirmed") return Response.json({ error: "이미 가입된 이메일입니다. 로그인하세요." }, { status: 409 });
    }
    const signedIn = await supabase.auth.signInWithPassword({ email, password });
    if (signedIn.error) return Response.json({ error: "계정은 생성됐지만 로그인하지 못했습니다. 다시 로그인하세요." }, { status: 409 });
    return Response.json({ ok: true, requiresConfirmation: false });
  }

  const origin = new URL(request.url).origin;
  const result = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${origin}/auth/callback` } });
  if (result.error) return Response.json({ error: signupError(result.error.code, result.error.message) }, { status: 400 });
  return Response.json({ ok: true, requiresConfirmation: !result.data.session });
}
