import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { demoAsset, demoInteractions, demoState, deterministicReply } from "../lib/demo";
import { safeDownloadUrl, safeExternalUrl } from "../lib/safe-url";

const root = new URL("../", import.meta.url);

test("demo state fills every context surface with deterministic local evidence", () => {
  const state = demoState();
  for (const values of [state.files, state.artifacts, state.memories, state.pkmSources, state.citations, state.permissions, state.trace]) assert.ok(values.length > 0);
  assert.equal(demoState("demo-api").activeConversationId, "demo-api");
  assert.deepEqual(demoInteractions(), demoInteractions());
  assert.deepEqual(new Set(demoInteractions().map((interaction) => interaction.kind)), new Set(["select", "input", "form", "file", "oauth", "permission"]));
  assert.equal(demoInteractions().filter((interaction) => interaction.kind === "permission").length, 4);
  assert.equal(deterministicReply("same prompt"), deterministicReply("same prompt"));
  assert.equal(demoAsset("artifact", "a1")?.name, "q3-launch-brief.md");
  assert.equal(demoAsset("file", "missing"), undefined);
});

test("citation and demo download links reject executable or ambiguous URLs", () => {
  assert.equal(safeExternalUrl("https://example.com/evidence"), "https://example.com/evidence");
  for (const unsafe of ["javascript:alert(1)", "data:text/html,bad", "internal note", "/relative"]) assert.equal(safeExternalUrl(unsafe), undefined);
  assert.equal(safeDownloadUrl("/api/artifacts?id=a1"), "/api/artifacts?id=a1");
  assert.equal(safeDownloadUrl("blob:https://example.com/id"), "blob:https://example.com/id");
  for (const unsafe of ["javascript:alert(1)", "//evil.test/file", "/api/files?id=f1&next=evil", "/api/other?id=a1"]) assert.equal(safeDownloadUrl(unsafe), undefined);
});

test("demo downloads are gated before configuration while production ownership remains intact", async () => {
  const [files, artifacts] = await Promise.all([
    readFile(new URL("app/api/files/route.ts", root), "utf8"),
    readFile(new URL("app/api/artifacts/route.ts", root), "utf8"),
  ]);
  for (const source of [files, artifacts]) {
    assert.ok(source.indexOf("localDemoEnabled()") < source.indexOf("!supabaseConfigured()"));
    assert.match(source, /x-content-type-options/u);
    assert.match(source, /eq\("user_id", user\.id\)/u);
  }
});
