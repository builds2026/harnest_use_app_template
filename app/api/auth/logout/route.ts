import { createSupabaseServer } from "@/lib/supabase/server";

export async function POST() {
  await (await createSupabaseServer()).auth.signOut();
  return Response.json({ ok: true });
}
