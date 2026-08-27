import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { RunCommandSchema } from "@harnestai/protocol";
import { authorizationRedirect, connectionCredential, oauthConfig, oauthPopup, oauthStateHash, storedOAuthCredential } from "../lib/oauth";
import { retrySafeCommand, runCommandKey } from "../lib/run-command";
import { fileCommitRecovery, providerArtifactPath } from "../lib/provider-file-commit";

const root = new URL("../", import.meta.url);
const migration = () => readFile(new URL("supabase/migrations/20260826000000_v15_security_durability.sql", root), "utf8");

test("chat enqueue is one service-only database transaction", async () => {
  const [sql, route] = await Promise.all([migration(), readFile(new URL("app/api/chat/route.ts", root), "utf8")]);
  for (const table of ["messages", "context_refs", "runs", "jobs"]) assert.match(sql, new RegExp(`insert into ${table}\\b`, "u"));
  assert.match(route, /admin\.rpc\("enqueue_chat"/u);
  assert.doesNotMatch(route, /admin\.from\("(?:context_refs|runs|jobs)"\)\.insert/u);
  assert.doesNotMatch(route, /from\("messages"\)\.insert/u);
});

test("provider file commit recovers each crash boundary without a live database", () => {
  const expected = { size: 3, sha256: "a".repeat(64) };
  assert.equal(fileCommitRecovery({ status: "pending", requested: expected, expected }), "upload", "crash after DB claim retries the upload");
  assert.equal(fileCommitRecovery({ status: "pending", requested: expected, expected, stored: expected }), "finalize", "crash after Storage upload reuses the object");
  assert.equal(fileCommitRecovery({ status: "pending", requested: expected, expected, stored: expected, artifact: expected }), "finalize", "crash before upload-state update reuses the artifact");
  assert.equal(fileCommitRecovery({ status: "committed", requested: expected, expected, artifact: expected }), "complete", "lost final response returns the committed artifact");
  assert.equal(fileCommitRecovery({ status: "pending", requested: expected, expected, stored: { ...expected, sha256: "b".repeat(64) } }), "cleanup");
  assert.equal(fileCommitRecovery({ status: "pending", requested: { ...expected, size: 4 }, expected }), "reject");
  assert.equal(providerArtifactPath("user", "conversation", "provider", "unsafe name.txt"), "user/conversation/provider/unsafe_name.txt");
});

test("provider file finalization is idempotent and atomic in the service RPC", async () => {
  const [sql, route] = await Promise.all([migration(), readFile(new URL("app/api/internal/providers/context/route.ts", root), "utf8")]);
  assert.match(route, /claim_provider_file_upload/u);
  assert.match(route, /\.download\(path\)[\s\S]*sameFile/u);
  assert.match(route, /finalize_provider_file_upload/u);
  assert.match(route, /fail_provider_file_upload/u);
  assert.doesNotMatch(route, /from\("artifacts"\)\.insert|provider_file_uploads"\)\.update/u);
  assert.match(sql, /finalize_provider_file_upload[\s\S]*insert into artifacts[\s\S]*on conflict\(storage_path\) do nothing[\s\S]*update provider_file_uploads set status='committed'/u);
  assert.match(sql, /finalize_provider_file_upload[\s\S]*if upload\.status='committed'[\s\S]*return jsonb_build_object\('status','committed'/u);
  assert.match(sql, /claim_provider_file_upload[\s\S]*expected_size_bytes=p_size,expected_sha256=p_sha256/u);
});

test("active leases and authenticated resumes refresh an expired owned context", async () => {
  const [sql, worker, command] = await Promise.all([
    migration(), readFile(new URL("app/api/internal/worker/route.ts", root), "utf8"),
    readFile(new URL("app/api/runs/[runId]/commands/route.ts", root), "utf8"),
  ]);
  assert.match(sql, /refresh_run_context[\s\S]*expires_at=now\(\)\+interval '15 minutes'/u);
  assert.match(sql, /lease_jobs[\s\S]*update context_refs c set expires_at=now\(\)\+interval '15 minutes'/u);
  assert.match(sql, /renew_job_lease[\s\S]*update context_refs set expires_at=now\(\)\+interval '15 minutes'/u);
  assert.match(sql, /begin_run_command[\s\S]*refresh_run_context/u);
  assert.ok(command.indexOf("begin_run_command") < command.indexOf("sdk.respond"), "reservation and refresh must precede the interaction response");
  assert.match(worker, /renew_job_lease/u);
});

test("terminal runs reject commands before external or queue mutation", async () => {
  const route = await readFile(new URL("app/api/runs/[runId]/commands/route.ts", root), "utf8");
  const terminal = route.indexOf('["succeeded", "failed", "cancelled"].includes(run.data.status)');
  assert.ok(terminal >= 0 && terminal < route.indexOf("harnestClient()"));
  assert.doesNotMatch(route, /from\("jobs"\)\.insert/u);
});

test("run ownership is checked before every external command side effect", async () => {
  const route = await readFile(new URL("app/api/runs/[runId]/commands/route.ts", root), "utf8");
  const owned = route.indexOf('.eq("user_id", user.id).single()');
  assert.ok(owned >= 0, "the controllable run lookup must be scoped to the authenticated user");
  for (const effect of ["sdk.cancel", "sdk.respond", "sdk.command"]) {
    assert.ok(owned < route.indexOf(effect), `ownership must be checked before ${effect}`);
  }
});

test("accepted command retries are idempotent", async () => {
  const [sql, route] = await Promise.all([migration(), readFile(new URL("app/api/runs/[runId]/commands/route.ts", root), "utf8")]);
  assert.match(sql, /if receipt_status='accepted' then return 'accepted'/u);
  assert.match(sql, /if exists\(select 1 from run_command_receipts[\s\S]*status='accepted'\) then return true/u);
  assert.match(route, /begun\.data === "accepted"[\s\S]*duplicate: true/u);
});

test("response-loss retry forwards the same deterministic Harnest command id", () => {
  const command = { type: "message", target: { kind: "run" }, content: "continue" } as const;
  const key = runCommandKey({ command });
  const first = retrySafeCommand(command, key);
  const retry = retrySafeCommand(command, key);
  assert.deepEqual(retry, first);
  assert.match(first.commandId ?? "", /^command_[a-f0-9]{64}$/u);
  assert.equal(RunCommandSchema.safeParse(first).success, true);
  assert.equal(new Set([first.commandId, retry.commandId]).size, 1);
  assert.equal(retrySafeCommand({ ...command, commandId: "caller_id" }, key).commandId, "caller_id");
});

test("concurrent commands serialize to one pending receipt and one active worker", async () => {
  const sql = await migration();
  assert.match(sql, /unique index run_command_one_pending_idx[\s\S]*where status='pending'/u);
  assert.match(sql, /select status into run_status from runs[\s\S]*for update/u);
  assert.match(sql, /status='pending'\) then return 'busy'/u);
  assert.match(sql, /unique index jobs_one_active_harnest_run_idx[\s\S]*status in \('queued','leased'\)/u);
  assert.match(sql, /accept_run_command[\s\S]*if not exists\(select 1 from jobs[\s\S]*insert into jobs/u);
});

test("expired max-attempt leases terminalize their job and run", async () => {
  const sql = await migration();
  assert.match(sql, /status='leased' and lease_expires_at < now\(\) and attempts >= max_attempts/u);
  assert.match(sql, /update jobs set status='failed'/u);
  assert.match(sql, /update runs set status='failed'[\s\S]*Worker lease expired after maximum attempts/u);
});

test("duplicate worker events reconcile projections transactionally", async () => {
  const [sql, route] = await Promise.all([migration(), readFile(new URL("app/api/internal/worker/route.ts", root), "utf8")]);
  assert.match(route, /rpc\("persist_worker_event"/u);
  assert.doesNotMatch(route, /if \(!inserted\.data\) return/u);
  assert.match(sql, /insert into events[\s\S]*on conflict\(run_id,sequence\) do nothing/u);
  assert.match(sql, /on conflict\(run_id\) where role='assistant'/u);
  assert.match(sql, /on conflict\(run_id,citation_index\)/u);
  assert.match(sql, /update artifacts set run_id=leased\.run_id/u);
  assert.ok(sql.indexOf("insert into events") < sql.indexOf("if p_type='run.completed'"));
  assert.match(sql, /finish_job[\s\S]*r\.status in \('succeeded','cancelled'\)[\s\S]*then 'succeeded'/u);
  assert.match(sql, /finished_status='failed'[\s\S]*update runs set status='failed'/u);
  assert.doesNotMatch(route, /body\.action === "finish"[\s\S]*from\("runs"\)\.update/u);
});

test("generic OAuth uses server config, one-time state, and a secret-only store", async () => {
  const [start, callback, oldPage, sql] = await Promise.all([
    readFile(new URL("app/api/oauth/start/route.ts", root), "utf8"),
    readFile(new URL("app/oauth/callback/route.ts", root), "utf8"),
    readFile(new URL("components/workspace.tsx", root), "utf8"), migration(),
  ]);
  assert.match(start, /oauthConfig\(connection\.data\.public_config\)/u);
  assert.match(start, /state_hash: oauthStateHash\(state\)/u);
  assert.match(callback, /claim_oauth_session/u);
  assert.match(callback, /grant_type: "authorization_code"/u);
  assert.match(callback, /store_oauth_connection_secret/u);
  assert.doesNotMatch(callback, /searchParams\.get\("connectionRef"\)/u);
  assert.doesNotMatch(oldPage, /searchParams\.get\("connectionRef"\)|access_token|refresh_token/u);
  assert.match(sql, /oauth_sessions[\s\S]*consumed_at is null and expires_at>now\(\)/u);
  assert.match(sql, /vault\.(?:create_secret|update_secret)/u);
});

test("OAuth helpers preserve reserved bindings and never post tokens", async () => {
  const config = oauthConfig({ oauth: {
    authorizationUrl: "https://identity.example/authorize", tokenUrl: "https://identity.example/token", clientId: "public-client",
    scopes: ["read", "write"], authorizationParams: { prompt: "consent", state: "forged" }, tokenAuthMethod: "none",
  } });
  const redirect = authorizationRedirect(config, "https://app.example/oauth/callback", "owned-state");
  assert.equal(redirect.searchParams.get("state"), "owned-state");
  assert.equal(redirect.searchParams.get("scope"), "read write");
  const stored = storedOAuthCredential({ access_token: "server-token", refresh_token: "server-refresh", token_type: "Bearer" });
  assert.equal(connectionCredential(stored), "server-token");
  assert.equal(oauthStateHash("state").length, 64);
  const popup = oauthPopup("https://app.example", "interaction", "connection:opaque");
  const html = await popup.text();
  assert.match(html, /harnest\.oauth\.complete/u);
  assert.doesNotMatch(html, /server-token|server-refresh/u);
  assert.match(popup.headers.get("content-security-policy") ?? "", /script-src 'nonce-/u);
});
