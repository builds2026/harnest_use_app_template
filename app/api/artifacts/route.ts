import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";

export async function GET(request: Request) {
  if (!supabaseConfigured()) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^[0-9a-f-]{36}$/iu.test(id)) return NextResponse.json({ error: "Invalid artifact reference." }, { status: 400 });
  const { data: { user } } = await (await createSupabaseServer()).auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const admin = createSupabaseAdmin();
  const artifact = await admin.from("artifacts").select("storage_bucket,storage_path").eq("id", id).eq("user_id", user.id).eq("status", "ready").single();
  if (artifact.error) return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
  const signed = await admin.storage.from(artifact.data.storage_bucket).createSignedUrl(artifact.data.storage_path, 60);
  if (signed.error) return NextResponse.json({ error: "Could not open artifact." }, { status: 502 });
  return NextResponse.redirect(signed.data.signedUrl, 303);
}
