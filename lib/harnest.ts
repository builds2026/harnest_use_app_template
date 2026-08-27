import { HarnestClient, type WireEnvelope } from "@harnestai/sdk";
import type { AppReadiness, HarnessCapability } from "./types";

type PublicContract = {
  capabilities: string[];
  requiredConnections: string[];
  tools: { component: string; tool?: string; connectionId?: string }[];
};

export type HarnestRuntime = { configured: boolean; healthy: boolean; readyConnections?: string[]; contract?: PublicContract; error?: string };

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

const words = (value: string) => value.replace(/^builtin\./u, "").replaceAll(/[._-]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());

export async function readHarnestRuntime(): Promise<HarnestRuntime> {
  if (!process.env.HARNEST_URL) return { configured: false, healthy: false, error: "HARNEST_URL is not configured" };
  const base = process.env.HARNEST_URL.replace(/\/+$/u, "");
  const headers = process.env.HARNEST_TOKEN ? { authorization: `Bearer ${process.env.HARNEST_TOKEN}` } : undefined;
  try {
    const [health, contract] = await Promise.all([
      fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(5_000) }),
      fetch(`${base}/contract`, { headers, signal: AbortSignal.timeout(5_000) }),
    ]);
    if (!health.ok || !contract.ok) throw new Error(`Harnest returned HTTP ${!health.ok ? health.status : contract.status}`);
    const [healthValue, contractValue] = await Promise.all([health.json(), contract.json()]) as [unknown, unknown];
    const healthObject = object(healthValue);
    const value = object(contractValue);
    if (healthObject?.ok !== true || !Array.isArray(value?.capabilities) || !Array.isArray(value.requiredConnections) || !Array.isArray(value.tools)) {
      throw new Error("Harnest returned an invalid health or contract response");
    }
    const capabilities = value.capabilities.filter((item): item is string => typeof item === "string");
    const requiredConnections = value.requiredConnections.filter((item): item is string => typeof item === "string");
    const tools = value.tools.flatMap((item) => {
      const tool = object(item);
      return typeof tool?.component === "string" ? [{
        component: tool.component,
        ...(typeof tool.tool === "string" ? { tool: tool.tool } : {}),
        ...(typeof tool.connectionId === "string" ? { connectionId: tool.connectionId } : {}),
      }] : [];
    });
    const readyConnections = Array.isArray(healthObject.readyConnections)
      ? healthObject.readyConnections.filter((item): item is string => typeof item === "string")
      : [];
    return { configured: true, healthy: true, readyConnections, contract: { capabilities, requiredConnections, tools } };
  } catch (error) {
    return { configured: true, healthy: false, error: error instanceof Error ? error.message : "Harnest is unavailable" };
  }
}

export function deriveHarnestState(runtime: HarnestRuntime, readyConnectionNames: readonly string[]): {
  readiness: AppReadiness; capabilities: HarnessCapability[]; missing: string[];
} {
  const contract = runtime.contract;
  const readyConnections = new Set([...readyConnectionNames, ...(runtime.readyConnections ?? [])]);
  const requiredConnections = contract?.requiredConnections ?? [];
  const missingConnections = requiredConnections.filter((name) => !readyConnections.has(name));
  const harnest = !runtime.configured ? "not-configured" : runtime.healthy && contract ? "ready" : "unreachable";
  const ready = harnest === "ready" && missingConnections.length === 0;
  const capabilities: HarnessCapability[] = [
    ...(contract?.capabilities ?? []).map((id) => ({ id, label: words(id), kind: "capability" as const, ready })),
    ...(contract?.tools ?? []).map((tool) => ({
      id: `tool:${tool.component}`, label: words(tool.tool ?? tool.component), kind: "tool" as const,
      ready: harnest === "ready" && (!tool.connectionId || readyConnections.has(tool.connectionId)),
      ...(tool.connectionId ? { connectionId: tool.connectionId } : {}),
    })),
  ];
  return {
    readiness: { ready, harnest, requiredConnections, missingConnections, ...(runtime.error ? { message: runtime.error } : {}) },
    capabilities,
    missing: [...(harnest === "not-configured" ? ["HARNEST_URL"] : harnest === "unreachable" ? ["Harnest /health and /contract"] : []), ...missingConnections],
  };
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
    const requester = object(data.requester);
    if (requester) interaction.requester = selectedObject(requester, ["kind", "id"]);
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
