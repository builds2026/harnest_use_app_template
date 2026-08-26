import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";

export async function DELETE(request: Request) {
  if (!supabaseConfigured()) return Response.json({ error: "Supabase is not configured." }, { status: 503 });
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
  const body = await request.json().catch(() => undefined) as { id?: unknown } | undefined;
  if (!body || typeof body.id !== "string" || !/^[a-f0-9]{36}$/iu.test(body.id)) return Response.json({ error: "Invalid permission reference." }, { status: 400 });
  const deleted = await createSupabaseAdmin().from("permission_grants").delete().eq("user_id", user.id).eq("provider_ref", body.id).select("provider_ref").maybeSingle();
  if (deleted.error) return Response.json({ error: "Permission revoke failed." }, { status: 502 });
  return Response.json({ revoked: Boolean(deleted.data) });
}
