export type ContextInput =
  | { type: "memory"; key: string; value: string }
  | { type: "pkm"; title: string; content: string };

export function contextInput(value: unknown): ContextInput | { error: string } {
  if (!value || typeof value !== "object") return { error: "Invalid context request." };
  const body = value as Record<string, unknown>;
  if (body.type === "memory") {
    const key = typeof body.key === "string" ? body.key.trim() : "";
    const content = typeof body.value === "string" ? body.value.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(key) || !content || new TextEncoder().encode(content).byteLength > 32_000) return { error: "Memory requires a safe key and value up to 32 KB." };
    return { type: "memory", key, value: content };
  }
  if (body.type === "pkm") {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!title || title.length > 300 || !content || new TextEncoder().encode(content).byteLength > 262_144) return { error: "PKM requires a title and UTF-8 text up to 256 KB." };
    return { type: "pkm", title, content };
  }
  return { error: "Unsupported context type." };
}

export function pkmChunks(content: string, maximum = 4_000): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < content.length; offset += maximum) chunks.push(content.slice(offset, offset + maximum));
  return chunks;
}
