import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("owned run SSE supports replay ids, Last-Event-ID, heartbeat, and a durable wait", async () => {
  const [source, workspace] = await Promise.all([
    readFile(new URL("app/api/runs/[runId]/events/route.ts", root), "utf8"),
    readFile(new URL("components/workspace.tsx", root), "utf8"),
  ]);
  assert.match(source, /last-event-id/u);
  assert.match(source, /id: \$\{id\}/u);
  assert.match(source, /event: message/u);
  assert.match(source, /: heartbeat/u);
  assert.match(source, /status === "waiting"/u);
  assert.doesNotMatch(source, /status === "waiting"[^}]*break/u);
  assert.match(source, /eq\("user_id", user\.id\)/u);
  assert.match(source, /headers\.get\("last-event-id"\) \?\? new URL/u);
  assert.doesNotMatch(workspace, /events\?after=0/u);
});

test("chat enqueue has JSON ids and no fixed poll timeout", async () => {
  const source = await readFile(new URL("app/api/chat/route.ts", root), "utf8");
  assert.match(source, /status: "queued"/u);
  assert.match(source, /application\/json/u);
  assert.doesNotMatch(source, /poll < 1200|Run timed out/u);
});
