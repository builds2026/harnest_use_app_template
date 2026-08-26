export function providerPageLimit(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(50, Math.max(1, value)) : 20;
}

export function decodeProviderCursor(value: unknown) {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,32}$/u.test(value)) return undefined;
  const decoded = Number(Buffer.from(value, "base64url").toString("utf8"));
  return Number.isSafeInteger(decoded) && decoded >= 0 ? decoded : undefined;
}

export function nextProviderCursor(offset: number, returned: number, requested: number) {
  return returned > requested ? Buffer.from(String(offset + requested)).toString("base64url") : undefined;
}
