import { clientSecret, configuredAppOrigin, oauthConfig, oauthPopup, oauthStateHash, storedOAuthCredential } from "@/lib/oauth";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
const object = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export async function GET(request: Request) {
  if (!supabaseConfigured()) return Response.json({ error: "Supabase is not configured." }, { status: 503 });
  const url = new URL(request.url); const state = url.searchParams.get("state"); const code = url.searchParams.get("code");
  if (!state || state.length > 1_024 || !code || code.length > 8_192) return Response.json({ error: "Invalid OAuth callback." }, { status: 400 });
  const supabase = await createSupabaseServer(); const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
  const admin = createSupabaseAdmin();
  const claimed = await admin.rpc("claim_oauth_session", { p_state_hash: oauthStateHash(state), p_user_id: user.id });
  const session = object(claimed.data);
  if (claimed.error || !session || typeof session.connectionId !== "string" || typeof session.interactionId !== "string" || typeof session.redirectUri !== "string") {
    return Response.json({ error: "OAuth state is invalid, expired, or already used." }, { status: 409 });
  }
  try {
    const origin = configuredAppOrigin();
    if (new URL(session.redirectUri).origin !== origin || new URL(session.redirectUri).pathname !== "/oauth/callback") throw new Error("OAuth callback binding is invalid.");
    const connection = await admin.from("connections").select("id,public_config,vault_secret_id").eq("id", session.connectionId).eq("user_id", user.id).single();
    if (connection.error) throw new Error("OAuth connection is unavailable.");
    const config = oauthConfig(connection.data.public_config);
    let existing: string | null = null;
    if (connection.data.vault_secret_id) {
      const read = await admin.rpc("read_connection_secret", { p_connection_id: connection.data.id });
      if (read.error) throw new Error("OAuth client credential is unavailable.");
      existing = typeof read.data === "string" ? read.data : null;
    }
    const secret = clientSecret(existing);
    if (config.tokenAuthMethod !== "none" && !secret) throw new Error("OAuth client secret is not configured.");
    const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: session.redirectUri, client_id: config.clientId });
    const headers = new Headers({ accept: "application/json", "content-type": "application/x-www-form-urlencoded" });
    if (config.tokenAuthMethod === "client_secret_basic") headers.set("authorization", `Basic ${Buffer.from(`${config.clientId}:${secret}`).toString("base64")}`);
    if (config.tokenAuthMethod === "client_secret_post" && secret) form.set("client_secret", secret);
    const exchanged = await fetch(config.tokenUrl, { method: "POST", headers, body: form, redirect: "error", signal: AbortSignal.timeout(30_000) });
    const bytes = new Uint8Array(await exchanged.arrayBuffer());
    if (!exchanged.ok || bytes.byteLength > 65_536) throw new Error("OAuth provider rejected the code exchange.");
    const token = object(JSON.parse(new TextDecoder().decode(bytes)));
    if (!token) throw new Error("OAuth provider returned an invalid token response.");
    const stored = await admin.rpc("store_oauth_connection_secret", {
      p_connection_id: connection.data.id, p_user_id: user.id, p_secret: storedOAuthCredential(token, secret),
    });
    if (stored.error || typeof stored.data !== "string") throw new Error("OAuth credential could not be stored.");
    return oauthPopup(origin, session.interactionId, stored.data);
  } catch (error) {
    await admin.from("connections").update({ status: "error", last_error: "OAuth completion failed" }).eq("id", session.connectionId).eq("user_id", user.id);
    return Response.json({ error: error instanceof Error ? error.message : "OAuth completion failed." }, { status: 409 });
  }
}
