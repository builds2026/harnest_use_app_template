import { CONNECTION_PRESETS, connectionInput } from "@/lib/connections";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";

async function userId() {
  if (!supabaseConfigured()) return undefined;
  const { data: { user } } = await (await createSupabaseServer()).auth.getUser();
  return user?.id;
}

export async function GET() {
  const id = await userId();
  if (!id) return Response.json({ error: "Authentication required." }, { status: 401 });
  const result = await createSupabaseAdmin().from("connections")
    .select("name,kind,status,last_error,updated_at").eq("user_id", id).order("updated_at", { ascending: false });
  if (result.error) return Response.json({ error: "Could not load connections." }, { status: 502 });
  return Response.json({ connections: result.data }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request) {
  const id = await userId();
  if (!id) return Response.json({ error: "Authentication required." }, { status: 401 });
  const input = connectionInput(await request.json().catch(() => undefined));
  if ("error" in input) return Response.json(input, { status: 400 });
  const preset = CONNECTION_PRESETS[input.preset];

  const test = input.preset === "gemini"
    ? await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
      headers: { "x-goog-api-key": input.secret }, signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined)
    : await fetch("https://api.firecrawl.dev/v2/team/credit-usage", {
      headers: { authorization: `Bearer ${input.secret}` }, signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
  if (!test?.ok) return Response.json({ error: test ? `${preset.label} rejected this key (HTTP ${test.status}).` : `${preset.label} could not be reached.` }, { status: 400 });

  const admin = createSupabaseAdmin();
  const existing = await admin.from("connections").select("id").eq("user_id", id).eq("name", preset.name).maybeSingle();
  if (existing.error) return Response.json({ error: "Could not inspect the connection." }, { status: 502 });
  const saved = existing.data
    ? await admin.from("connections").update({ kind: preset.kind, public_config: preset.publicConfig, status: "pending", last_error: null }).eq("id", existing.data.id).eq("user_id", id).select("id").single()
    : await admin.from("connections").insert({ user_id: id, name: preset.name, kind: preset.kind, public_config: preset.publicConfig, status: "pending" }).select("id").single();
  if (saved.error) return Response.json({ error: "Could not save the connection." }, { status: 502 });
  const secret = await admin.rpc("store_oauth_connection_secret", { p_connection_id: saved.data.id, p_user_id: id, p_secret: input.secret });
  if (secret.error) {
    await admin.from("connections").update({ status: "error", last_error: "Credential storage failed." }).eq("id", saved.data.id);
    return Response.json({ error: "Could not store the credential securely." }, { status: 502 });
  }
  return Response.json({ connection: { name: preset.name, kind: preset.kind, status: "ready", label: preset.label } });
}
