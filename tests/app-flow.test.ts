import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { clientId } from "../lib/client-id";
import { deriveHarnestState, type HarnestRuntime } from "../lib/harnest";
import { enUS, koKR, localeFrom } from "../lib/i18n";

const root = new URL("../", import.meta.url);

test("readiness and tools come from the contract plus owned ready connections", () => {
  const runtime: HarnestRuntime = {
    configured: true,
    healthy: true,
    contract: {
      capabilities: ["web-search", "code-sandbox"],
      requiredConnections: ["model-main", "search-main", "sandbox-main"],
      tools: [
        { component: "search", tool: "builtin.web-search", connectionId: "search-main" },
        { component: "code", tool: "builtin.code-runner" },
      ],
    },
  };
  const state = deriveHarnestState({ ...runtime, readyConnections: ["sandbox-main"] }, ["model-main"]);
  assert.equal(state.readiness.ready, false);
  assert.deepEqual(state.readiness.missingConnections, ["search-main"]);
  assert.equal(state.capabilities.find(({ id }) => id === "tool:search")?.ready, false);
  assert.equal(state.capabilities.find(({ id }) => id === "tool:code")?.ready, true);
  assert.equal(state.readiness.missingConnections.includes("sandbox-main"), false);
});

test("browser enqueue owns one durable EventSource and per-turn file selection", async () => {
  const workspace = await readFile(new URL("components/workspace.tsx", root), "utf8");
  assert.match(workspace, /accept: "application\/json"/u);
  assert.equal(workspace.match(/new EventSource\(/gu)?.length, 1);
  assert.match(workspace, /const sequence = bridge\.sequence/u);
  assert.doesNotMatch(workspace, /const sequence = Number\(message\.lastEventId\)/u);
  assert.match(workspace, /fileIds: \[\.\.\.selectedFileIds\]/u);
  assert.doesNotMatch(workspace, /fileIds: state\.files\.map/u);
  assert.doesNotMatch(workspace, /readSse/u);
});

test("conversation history, stale-load guards, bounded run recovery, and modal rails are explicit", async () => {
  const workspace = await readFile(new URL("components/workspace.tsx", root), "utf8");
  assert.match(workspace, /searchParams\.set\("conversation", conversation\)/u);
  assert.match(workspace, /history\[`\$\{mode\}State`\]/u);
  assert.match(workspace, /addEventListener\("popstate", navigate\)/u);
  assert.match(workspace, /new AbortController\(\)[\s\S]*signal: controller\.signal/u);
  assert.match(workspace, /token !== loadToken\.current/u);
  assert.match(workspace, /setRunStatus\(recoveredRunStatus\(next\.activeRun\?\.status\)\)/u);
  assert.match(workspace, /MAX_STREAM_FAILURES = 3/u);
  assert.match(workspace, /STREAM_RECONNECT_TIMEOUT = 10_000/u);
  assert.match(workspace, /workspace\.retryStream/u);
  assert.match(workspace, /<Dialog\.Root[\s\S]*modal/u);
  assert.match(workspace, /<Dialog\.Backdrop className="rail-dialog-backdrop"/u);
  assert.match(workspace, /<Dialog\.Close className="icon-button"/u);
  assert.doesNotMatch(workspace, /className="scrim/u);
});

test("browser mutations expose failure paths and strict in-flight guards", async () => {
  const workspace = await readFile(new URL("components/workspace.tsx", root), "utf8");
  for (const guard of ["uploadLock.current", "signOutLock.current", "busyLock.current"]) assert.match(workspace, new RegExp(guard.replace(".", "\\."), "u"));
  for (const error of ["workspace.error.upload", "workspace.error.signOut", "workspace.error.permission", "memory.failed", "memory.removeFailed", "pkm.failed", "pkm.removeFailed", "interaction.failed"]) assert.match(workspace, new RegExp(error.replaceAll(".", "\\."), "u"));
  assert.match(workspace, /response\.json\(\)\.catch\(\(\) => \(\{\}\)\)/u);
});

test("shared connection fallback is absent and Markdown skips raw HTML", async () => {
  const [provider, env, workspace, state] = await Promise.all([
    readFile(new URL("app/api/internal/providers/context/route.ts", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
    readFile(new URL("components/workspace.tsx", root), "utf8"),
    readFile(new URL("app/api/state/route.ts", root), "utf8"),
  ]);
  assert.doesNotMatch(provider + env, /ARC_SHARED_TEST_CONNECTIONS/u);
  assert.match(provider, /eq\("user_id", userId\)/u);
  assert.match(workspace, /<ReactMarkdown skipHtml/u);
  assert.doesNotMatch(workspace, /dangerouslySetInnerHTML/u);
  assert.match(state, /errors: partialErrors/u);
  assert.ok(state.includes("partialErrors.push(`Could not load ${label}.`)"));
  assert.doesNotMatch(state, /partialErrors\.push\(`Could not load \$\{label\}: \$\{error\.message\}/u);
});

test("locale preference uses a saved choice before browser language", () => {
  assert.deepEqual(Object.keys(koKR).sort(), Object.keys(enUS).sort());
  assert.equal(localeFrom(undefined, "ko-KR,ko;q=0.9,en;q=0.8"), "ko-KR");
  assert.equal(localeFrom("en-US", "ko-KR"), "en-US");
  assert.equal(localeFrom(undefined, "en-US"), "en-US");
});

test("client message ids work when insecure HTTP omits crypto.randomUUID", () => {
  const values = [1, 2, 3, 4];
  const source = { getRandomValues: (array: Uint32Array) => { array.set(values); return array; } };
  assert.equal(clientId(source), "00000001000000020000000300000004");
  assert.notEqual(clientId({}), clientId({}));
});
