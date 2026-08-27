type RandomSource = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint32Array) => Uint32Array;
};

let fallbackSequence = 0;

export function clientId(source: RandomSource | undefined = globalThis.crypto): string {
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  if (typeof source?.getRandomValues === "function") {
    return Array.from(source.getRandomValues(new Uint32Array(4)), (part) => part.toString(16).padStart(8, "0")).join("");
  }
  return `client-${Date.now().toString(36)}-${(fallbackSequence += 1).toString(36)}`;
}
