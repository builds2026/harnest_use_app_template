export const PROVIDER_RESPONSE_BYTES = 1_048_576;
export const PROVIDER_VALUE_BYTES = 65_536;

export function serializedBytes(value: unknown) {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { return Number.POSITIVE_INFINITY; }
}

export function providerResult(result: unknown) {
  const body = JSON.stringify({ result });
  if (new TextEncoder().encode(body).byteLength > PROVIDER_RESPONSE_BYTES) return Response.json({ error: "Provider response exceeds 1 MiB." }, { status: 413 });
  return new Response(body, { headers: { "cache-control": "private, no-store", "content-type": "application/json" } });
}

export function connectionTargetAllowed(base: URL, target: URL) {
  const directory = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  return target.origin === base.origin && (target.pathname === base.pathname || target.pathname.startsWith(directory));
}
