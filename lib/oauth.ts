import { createHash, randomBytes } from "node:crypto";

type Json = Record<string, unknown>;

export interface OAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  authorizationParams: Record<string, string>;
  tokenAuthMethod: "client_secret_basic" | "client_secret_post" | "none";
}

const object = (value: unknown): Json | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : undefined;
const endpoint = (value: unknown) => {
  if (typeof value !== "string") throw new Error("OAuth endpoint is missing.");
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) throw new Error("OAuth endpoint is not allowed.");
  return url.toString();
};

export function oauthConfig(publicConfig: unknown): OAuthConfig {
  const oauth = object(object(publicConfig)?.oauth);
  if (!oauth || typeof oauth.clientId !== "string" || !oauth.clientId || oauth.clientId.length > 512) throw new Error("Connection OAuth public configuration is incomplete.");
  const auth = object(oauth.authorizationParams) ?? {};
  const authorizationParams = Object.fromEntries(Object.entries(auth).flatMap(([key, value]) =>
    /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(key) && !/^(?:state|redirect_uri|client_id|response_type|code|client_secret)$/iu.test(key) && typeof value === "string" && value.length <= 2_000 ? [[key, value]] : []));
  const method = oauth.tokenAuthMethod;
  return {
    authorizationUrl: endpoint(oauth.authorizationUrl), tokenUrl: endpoint(oauth.tokenUrl), clientId: oauth.clientId,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.filter((scope): scope is string => typeof scope === "string" && scope.length <= 200).slice(0, 50) : [],
    authorizationParams, tokenAuthMethod: method === "client_secret_post" || method === "none" ? method : "client_secret_basic",
  };
}

export function configuredAppOrigin() {
  const value = process.env.APP_ORIGIN;
  if (!value) throw new Error("APP_ORIGIN is required for OAuth.");
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.pathname !== "/" || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) throw new Error("APP_ORIGIN must be an HTTPS origin or local loopback origin.");
  return url.origin;
}

export const oauthState = () => randomBytes(32).toString("base64url");
export const oauthStateHash = (state: string) => createHash("sha256").update(state).digest("hex");

export function authorizationRedirect(config: OAuthConfig, redirectUri: string, state: string) {
  const url = new URL(config.authorizationUrl);
  for (const [key, value] of Object.entries(config.authorizationParams)) url.searchParams.set(key, value);
  url.searchParams.set("response_type", "code"); url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri); url.searchParams.set("state", state);
  if (config.scopes.length) url.searchParams.set("scope", config.scopes.join(" "));
  return url;
}

export function clientSecret(value: string | null) {
  if (!value) return undefined;
  try { const parsed = object(JSON.parse(value)); return typeof parsed?.clientSecret === "string" ? parsed.clientSecret : undefined; }
  catch { return value; }
}

export function connectionCredential(value: string) {
  try { const parsed = object(JSON.parse(value)); return typeof parsed?.accessToken === "string" ? parsed.accessToken : value; }
  catch { return value; }
}

export function storedOAuthCredential(token: Json, secret?: string) {
  if (typeof token.access_token !== "string" || !token.access_token || token.access_token.length > 32_000) throw new Error("OAuth provider did not return a valid access token.");
  const expiresIn = typeof token.expires_in === "number" && Number.isFinite(token.expires_in) && token.expires_in > 0 ? token.expires_in : undefined;
  return JSON.stringify({
    accessToken: token.access_token,
    ...(typeof token.refresh_token === "string" ? { refreshToken: token.refresh_token } : {}),
    ...(typeof token.token_type === "string" ? { tokenType: token.token_type } : {}),
    ...(typeof token.scope === "string" ? { scope: token.scope } : {}),
    ...(expiresIn ? { expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString() } : {}),
    ...(secret ? { clientSecret: secret } : {}),
  });
}

export function oauthPopup(origin: string, interactionId: string, connectionRef: string) {
  const nonce = randomBytes(18).toString("base64url");
  const script = `if(window.opener){window.opener.postMessage(${JSON.stringify({ type: "harnest.oauth.complete", interactionId, connectionRef }).replaceAll("<", "\\u003c")},${JSON.stringify(origin)});window.close()}`;
  return new Response(`<!doctype html><meta charset="utf-8"><title>Connection complete</title><p>Connection complete. You may close this window.</p><script nonce="${nonce}">${script}</script>`, {
    headers: { "cache-control": "no-store", "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'none'; base-uri 'none'; frame-ancestors 'none'`, "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" },
  });
}
