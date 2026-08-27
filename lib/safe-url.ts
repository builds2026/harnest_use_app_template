export function safeExternalUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch { return undefined; }
}

export function safeDownloadUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("blob:")) return value;
  return /^\/api\/(?:files|artifacts)\?id=[A-Za-z0-9_-]{1,80}$/u.test(value) ? value : undefined;
}
