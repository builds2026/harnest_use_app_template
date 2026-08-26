import { HarnestClient, type WireEnvelope } from "@harnestai/sdk";

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const selectedObject = (value: unknown, keys: readonly string[]) => {
  const source = object(value) ?? {};
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
};

const publicValue = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string") return value.slice(0, 1_024);
  if (!value || typeof value !== "object" || depth >= 5) return value;
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => publicValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 25).map(([key, child]) => [
    key,
    /(?:api[-_]?key|authorization|secret|token|pass(?:word|phrase)|credentials?|cookies?|private[-_]?key|context[-_]?ref)$/iu.test(key)
      ? "[REDACTED]" : publicValue(child, depth + 1),
  ]));
};

export function harnestClient() {
  if (!process.env.HARNEST_URL) throw new Error("HARNEST_URL is not configured");
  return new HarnestClient({ baseUrl: process.env.HARNEST_URL, token: process.env.HARNEST_TOKEN });
}

/** Removes graph input/output, model text, tool arguments, and internal state. */
export function publicHarnestEvent(event: WireEnvelope, publicNodeId?: string): Record<string, unknown> {
  const data = object(event.data) ?? {};
  const selected = ["nodeId", "componentType", "iteration", "attempt", "tool", "callId", "turn", "risk", "ok", "durationMs", "approved", "source", "reason", "evaluator", "passed", "score", "message", "phase", "code", "retryable", "finishReason"];
  const safe: Record<string, unknown> = {
    protocolVersion: event.protocolVersion, eventId: event.eventId, runId: event.runId,
    sequence: event.sequence, time: event.time, type: event.type,
    ...Object.fromEntries(selected.filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]])),
  };
  if (event.type === "text.delta" && data.nodeId === publicNodeId && typeof data.text === "string") safe.text = data.text;
  if (event.type === "interaction.requested") {
    const kind = data.kind;
    const interaction = selectedObject(data, ["id", "kind", "title", "message", "blocking", "schema", "checkpoint", "expiresAt"]);
    const interactionData = object(data.data);
    if (kind === "oauth" && interactionData) {
      interaction.data = selectedObject(interactionData, ["elicitationId"]);
    } else if (kind === "permission" && interactionData) {
      interaction.data = {
        ...selectedObject(interactionData, ["previewLimited", "resourceResolved", "risk"]),
        ...(Object.hasOwn(interactionData, "input") ? { input: publicValue(interactionData.input) } : {}),
        ...(interactionData.permission ? { permission: selectedObject(interactionData.permission, ["toolId", "connectionId", "action", "capability", "resource"]) } : {}),
      };
    }
    safe.interaction = interaction;
  }
  if (event.type === "interaction.resolved") {
    for (const key of ["interactionId", "action", "permission"]) if (Object.hasOwn(data, key)) safe[key] = data[key];
  }
  return safe;
}

export const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

export function runEventLabel(type: string, payload: Record<string, unknown> = {}) {
  if (type === "run.started") return "Starting Harnest";
  if (type === "node.start") return `Running ${String(payload.nodeId ?? "workflow step")}`;
  if (type === "node.end") return `Completed ${String(payload.nodeId ?? "workflow step")}`;
  if (type === "tool.call") return `Calling ${String(payload.tool ?? "tool")}`;
  if (type === "tool.approval") return "Waiting for tool permission";
  if (type === "tool.result") return payload.ok === false ? "Tool failed" : "Tool completed";
  if (type.startsWith("team.")) return "Agent team working";
  if (type.startsWith("loop.")) return "Checking result quality";
  if (type.includes("cache")) return "Using context cache";
  return type.replaceAll(".", " ").replaceAll("-", " ");
}
