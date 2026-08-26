export type ConnectionPreset = "gemini" | "firecrawl";

export const CONNECTION_PRESETS = {
  gemini: {
    name: "gemini-main",
    kind: "provider",
    label: "Google AI Studio",
    publicConfig: {
      adapter: "gemini",
      model: "gemini-3.5-flash-lite",
      baseUrl: "https://generativelanguage.googleapis.com/",
      credentialHeader: "x-goog-api-key",
      credentialScheme: "",
    },
  },
  firecrawl: {
    name: "search-main",
    kind: "api",
    label: "Firecrawl",
    publicConfig: {
      connector: "firecrawl",
      baseUrl: "https://api.firecrawl.dev/",
      credentialHeader: "authorization",
      credentialScheme: "Bearer",
      operations: {
        "builtin.web-search": { path: "v2/search", method: "POST" },
        "builtin.web-scrape": { path: "v2/scrape", method: "POST" },
      },
    },
  },
} as const;

export function connectionInput(value: unknown): { preset: ConnectionPreset; secret: string } | { error: string } {
  if (!value || typeof value !== "object") return { error: "Invalid connection request." };
  const body = value as Record<string, unknown>;
  const preset = body.preset;
  const secret = typeof body.secret === "string" ? body.secret.trim() : "";
  if (preset !== "gemini" && preset !== "firecrawl") return { error: "Unsupported connection preset." };
  if (secret.length < 10 || secret.length > 8_192 || /\s/u.test(secret)) return { error: "Enter a valid API key." };
  return { preset, secret };
}
