import assert from "node:assert/strict";
import test from "node:test";
import { parseSSE } from "@harnestai/sdk";
import { publicHarnestEvent } from "../lib/harnest";

const stream = (text: string) => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); },
});
const event = {
  protocolVersion: "1.0" as const, eventId: "evt_1", runId: "run_1", sequence: 1,
  time: "2026-08-25T00:00:00.000Z", type: "tool.call", data: { nodeId: "search", tool: "web", input: { token: "secret" } },
};

test("public trace projection drops private inputs and outputs", () => {
  assert.deepEqual(publicHarnestEvent(event), {
    protocolVersion: "1.0", eventId: "evt_1", runId: "run_1", sequence: 1,
    time: "2026-08-25T00:00:00.000Z", type: "tool.call", nodeId: "search", tool: "web",
  });
});

test("uses the SDK SSE parser", async () => {
  const messages = [];
  const envelope = { ...event, type: "text.delta", data: { nodeId: "answer", text: "hi" } };
  for await (const message of parseSSE(stream(`id: 1\nevent: text.delta\ndata: ${JSON.stringify(envelope)}\n\n`))) messages.push(message);
  assert.deepEqual(messages.map(({ event: type }) => type), ["text.delta"]);
});
