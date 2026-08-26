import { authorizationRedirect, configuredAppOrigin, oauthConfig, oauthState, oauthStateHash } from "@/lib/oauth";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
const id = (value: string | null): value is string => typeof value === "string" && /^[0-9A-Za-z._:-]{1,200}$/u.test(value);

export async function GET(request: Request) {
  if (!supabaseConfigured()) return Response.json({ error: "Supabase is not configured." }, { status: 503 });
  const url = new URL(request.url); const runId = url.searchParams.get("runId"); const interactionId = url.searchParams.get("interactionId");
  if (!id(runId) || !id(interactionId)) return Response.json({ error: "Invalid OAuth interaction." }, { status: 400 });
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
  const run = await supabase.from("runs").select("id").eq("id", runId).eq("user_id", user.id).single();
  if (run.error) return Response.json({ error: "Run was not found." }, { status: 404 });
  const events = await supabase.from("events").select("type,payload").eq("run_id", runId)
    .in("type", ["interaction.requested", "interaction.resolved"]).order("sequence").limit(500);
  if (events.error) return Response.json({ error: "Interaction could not be loaded." }, { status: 502 });
  const pending = new Map<string, Record<string, unknown>>();
  for (const event of events.data ?? []) {
    const payload = event.payload as { interaction?: Record<string, unknown>; interactionId?: unknown };
    if (event.type === "interaction.requested" && typeof payload.interaction?.id === "string") pending.set(payload.interaction.id, payload.interaction);
    if (event.type === "interaction.resolved" && typeof payload.interactionId === "string") pending.delete(payload.interactionId);
  }
  const interaction = pending.get(interactionId); const data = interaction?.data as Record<string, unknown> | undefined;
  const connectionName = typeof data?.elicitationId === "string" ? data.elicitationId : undefined;
  if (interaction?.kind !== "oauth" || !connectionName) return Response.json({ error: "OAuth interaction is no longer pending." }, { status: 409 });
  const connection = await supabase.from("connections").select("id,public_config").eq("user_id", user.id).eq("name", connectionName).neq("status", "revoked").single();
  if (connection.error) return Response.json({ error: "The owned OAuth connection is not configured." }, { status: 409 });
  try {
    const origin = configuredAppOrigin(); const redirectUri = new URL("/oauth/callback", origin).toString();
    const state = oauthState(); const admin = createSupabaseAdmin();
    const session = await admin.from("oauth_sessions").insert({
      state_hash: oauthStateHash(state), user_id: user.id, run_id: runId, interaction_id: interactionId,
      connection_id: connection.data.id, redirect_uri: redirectUri,
    });
    if (session.error) throw session.error;
    return Response.redirect(authorizationRedirect(oauthConfig(connection.data.public_config), redirectUri, state), 303);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "OAuth could not be started." }, { status: 409 });
  }
}
