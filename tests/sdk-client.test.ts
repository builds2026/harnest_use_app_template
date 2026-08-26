import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { HarnestClient } from "@harnestai/sdk";

test("SDK drives create, events, command, respond, and cancel over v1", async () => {
  const requests: { method?: string; url?: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body });
    if (request.method === "POST" && request.url === "/v1/runs") return void response.writeHead(200, { "content-type": "application/json" }).end('{"runId":"run_1"}');
    if (request.method === "GET" && request.url?.startsWith("/v1/runs/run_1/events")) {
      const envelope = { protocolVersion: "1.0", eventId: "evt_1", runId: "run_1", sequence: 1, time: "2026-08-25T00:00:00.000Z", type: "run.completed", data: { type: "run-end", runId: "run_1", timestamp: "2026-08-25T00:00:00.000Z", sequence: 1, output: "done" } };
      return void response.writeHead(200, { "content-type": "text/event-stream" }).end(`id: 1\nevent: run.completed\ndata: ${JSON.stringify(envelope)}\n\n`);
    }
    response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const client = new HarnestClient(`http://127.0.0.1:${address.port}`);
    const { runId } = await client.create("hello", { context: { contextRef: "opaque-context", revisions: { conversation: 3 }, attachments: [{ ref: "opaque-file", name: "note.txt", mimeType: "text/plain", size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }] } });
    const events = [];
    for await (const event of client.events(runId)) events.push(event);
    await client.command(runId, { type: "message", commandId: "cmd_1", target: { kind: "run" }, content: "continue" });
    await client.respond(runId, { interactionId: "interaction_1", checkpointDigest: "abcdefghijklmnop", action: "submit", value: "yes" });
    await client.cancel(runId);
    assert.deepEqual(events.map(({ type }) => type), ["run.completed"]);
    assert.deepEqual(requests.map(({ method }) => method), ["POST", "GET", "POST", "POST", "DELETE"]);
    assert.deepEqual(JSON.parse(requests[0]!.body), { input: "hello", context: { contextRef: "opaque-context", revisions: { conversation: 3 }, attachments: [{ ref: "opaque-file", name: "note.txt", mimeType: "text/plain", size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }] } });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
