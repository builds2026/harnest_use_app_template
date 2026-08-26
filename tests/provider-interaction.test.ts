import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sha256Hex } from "../lib/file-integrity";
import { decodeProviderCursor, nextProviderCursor, providerPageLimit } from "../lib/provider-cursor";
import { connectionTargetAllowed, providerResult, PROVIDER_VALUE_BYTES, serializedBytes } from "../lib/provider-security";
import { publicHarnestEvent } from "../lib/harnest";
import { connectionInput, CONNECTION_PRESETS } from "../lib/connections";
import { contextInput, pkmChunks } from "../lib/context-input";

const root = new URL("../", import.meta.url);

test("provider cursors are opaque, bounded, and round-trip", () => {
  const next = nextProviderCursor(0, 21, 20);
  assert.equal(typeof next, "string");
  assert.equal(decodeProviderCursor(next), 20);
  assert.equal(decodeProviderCursor("not/a/cursor"), undefined);
  assert.equal(providerPageLimit(500), 50);
  assert.equal(providerPageLimit(-1), 1);
});

test("file integrity helper produces protocol SHA-256", async () => {
  assert.equal(await sha256Hex(new Blob(["abc"])), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("connection path scope rejects traversal and prefix lookalikes", () => {
  const base = new URL("https://provider.example/v1");
  assert.equal(connectionTargetAllowed(base, new URL("https://provider.example/v1/models")), true);
  assert.equal(connectionTargetAllowed(base, new URL("https://provider.example/v10/steal")), false);
  assert.equal(connectionTargetAllowed(base, new URL("https://provider.example/v1/../admin")), false);
  assert.equal(connectionTargetAllowed(base, new URL("https://evil.example/v1")), false);
});

test("connection setup accepts only reviewed presets and bounded single-line secrets", () => {
  assert.deepEqual(connectionInput({ preset: "gemini", secret: "  valid-key-12345  " }), { preset: "gemini", secret: "valid-key-12345" });
  assert.deepEqual(connectionInput({ preset: "custom", secret: "valid-key-12345" }), { error: "Unsupported connection preset." });
  assert.deepEqual(connectionInput({ preset: "firecrawl", secret: "has whitespace" }), { error: "Enter a valid API key." });
  assert.equal(CONNECTION_PRESETS.firecrawl.publicConfig.baseUrl, "https://api.firecrawl.dev/");
});

test("host memory and PKM input is bounded before persistence", () => {
  assert.deepEqual(contextInput({ type: "memory", key: "writing.style", value: "Concise" }), { type: "memory", key: "writing.style", value: "Concise" });
  assert.deepEqual(contextInput({ type: "memory", key: "bad key", value: "x" }), { error: "Memory requires a safe key and value up to 32 KB." });
  assert.deepEqual(contextInput({ type: "pkm", title: "Guide", content: "Owned knowledge" }), { type: "pkm", title: "Guide", content: "Owned knowledge" });
  assert.deepEqual(pkmChunks("abcdef", 2), ["ab", "cd", "ef"]);
});

test("provider values and envelopes have hard byte ceilings", async () => {
  assert.ok(serializedBytes("x".repeat(PROVIDER_VALUE_BYTES + 1)) > PROVIDER_VALUE_BYTES);
  assert.equal(providerResult({ value: "x".repeat(1_048_576) }).status, 413);
});

test("provider bridge exposes paged operations and dereferenceable verified files", async () => {
  const [provider, reader, upload] = await Promise.all([
    readFile(new URL("app/api/internal/providers/context/route.ts", root), "utf8"),
    readFile(new URL("app/api/internal/providers/files/[ref]/route.ts", root), "utf8"),
    readFile(new URL("app/api/files/route.ts", root), "utf8"),
  ]);
  for (const operation of ["conversation.read", "memory.search", "memory.upsert", "memory.delete", "cache.get", "cache.put", "cache.delete", "permissions.list", "permissions.find", "permissions.grant", "permissions.revoke", "connections.resolve", "connections.fetch", "connections.execute", "file.read", "file.create", "file.commit", "files.list"]) assert.match(provider, new RegExp(operation.replace(".", "\\."), "u"));
  assert.match(provider, /\.range\(offset, offset \+ limit\)/u);
  assert.doesNotMatch(provider, /messages[^\n]*\.limit\(40\)|memories[^\n]*\.limit\(20\)|pkm_chunks[^\n]*\.limit\(12\)/u);
  assert.match(reader, /internalRequestAuthorized/u);
  assert.match(reader, /content-range/u);
  assert.match(reader, /File integrity verification failed/u);
  assert.match(upload, /sha256Hex/u);
});

test("worker leases one job, renews it, and reconnects paused SDK streams", async () => {
  const [worker, route] = await Promise.all([
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("app/api/internal/worker/route.ts", root), "utf8"),
  ]);
  assert.match(route, /p_limit: 1/u);
  assert.match(worker, /setInterval/u);
  assert.match(worker, /event\.type === "run\.paused"/u);
  assert.match(worker, /sdk\.events\(externalRunId, \{ after \}\)/u);
  assert.match(worker, /idempotencyKey: job\.ref/u);
  assert.match(worker, /resumeRunId: externalRunId/u);
  assert.match(worker, /prepareResume/u);
  assert.match(worker, /snapshotState/u);
  assert.doesNotMatch(worker, /AbortSignal\.timeout/u);
});

test("public interaction projection keeps only OAuth and permission UI metadata", () => {
  const base = { protocolVersion: "1.0", eventId: "evt.1", runId: "run.1", sequence: 1, time: "2026-08-25T00:00:00.000Z", type: "interaction.requested" } as const;
  const oauth = publicHarnestEvent({ ...base, data: {
    id: "oauth.1", runId: "run.1", nodeId: "node", kind: "oauth", requester: { kind: "harness", id: "node" },
    title: "Connect", message: "Connect", blocking: "run", checkpoint: { revision: 0, sequence: 0, digest: "abcdefghijklmnop" }, createdAt: base.time,
    data: { url: "https://app.example/connect", state: "state", connectionRef: "connection", elicitationId: "github-oauth", token: "must-not-pass" },
  } });
  assert.deepEqual((oauth.interaction as { data: unknown }).data, { elicitationId: "github-oauth" });

  const permission = publicHarnestEvent({ ...base, data: {
    id: "permission.1", runId: "run.1", nodeId: "node", kind: "permission", requester: { kind: "tool", id: "tool" },
    title: "Allow", message: "Allow", blocking: "run", checkpoint: { revision: 0, sequence: 0, digest: "abcdefghijklmnop" }, createdAt: base.time,
    data: { previewLimited: false, resourceResolved: true, input: { path: "work.txt", apiKey: "must-not-pass" }, permission: { toolId: "file", capability: "workspace-write", resource: "work.txt", apiKey: "must-not-pass" } },
  } });
  assert.deepEqual((permission.interaction as { data: unknown }).data, {
    previewLimited: false, resourceResolved: true, input: { path: "work.txt", apiKey: "[REDACTED]" },
    permission: { toolId: "file", capability: "workspace-write", resource: "work.txt" },
  });
});

test("UI covers every protocol interaction kind without credential inputs", async () => {
  const source = await readFile(new URL("components/workspace.tsx", root), "utf8");
  for (const kind of ["select", "input", "form", "file", "oauth", "permission"]) assert.match(source, new RegExp(`kind === ["']${kind}["']`, "u"));
  assert.match(source, /checkpointDigest/u);
  assert.match(source, /expiresAt/u);
  assert.match(source, /enumAt/u);
  assert.match(source, /minimum/u);
  assert.match(source, /event\.origin !== location\.origin/u);
  assert.match(source, /harnest\.oauth\.complete/u);
  assert.match(source, /\/api\/oauth\/start\?runId=/u);
  assert.doesNotMatch(source, /data\.authorizationUrl|data\.url|data\.state/u);
  assert.match(source, /disabled=\{!persistentPermissionAllowed\}/u);
  const interaction = source.slice(source.indexOf("function InteractionCard"), source.indexOf("function ArtifactPanel"));
  assert.doesNotMatch(interaction, /type=["']password["']|access[_ -]?token|client[_ -]?secret/iu);
});
