import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { POST as providerApi } from "../app/api/internal/providers/context/route";
import { POST as workerApi } from "../app/api/internal/worker/route";

const root = new URL("../", import.meta.url);

test("standalone worker has no Supabase dependency or credential contract", async () => {
  const [source, manifest, environment] = await Promise.all([
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("worker/package.json", root), "utf8"),
    readFile(new URL("worker/.env.example", root), "utf8"),
  ]);
  for (const text of [source, manifest, environment]) {
    assert.doesNotMatch(text, /@supabase|createClient|SUPABASE_SERVICE_ROLE_KEY|NEXT_PUBLIC_SUPABASE_URL/u);
  }
  assert.match(manifest, /@harnestai\/sdk/u);
  assert.match(environment, /NEXTJS_INTERNAL_URL/u);
  assert.match(environment, /PROVIDER_BRIDGE_TOKEN/u);
  assert.match(environment, /HARNEST_URL/u);
  assert.doesNotMatch(source, /user_id|conversation_id|run_id/u);
});

test("internal routes reject missing and wrong shared tokens before data access", async () => {
  const previous = process.env.PROVIDER_BRIDGE_TOKEN;
  process.env.PROVIDER_BRIDGE_TOKEN = "correct-shared-token-value";
  try {
    for (const [route, path] of [[workerApi, "worker"], [providerApi, "providers/context"]] as const) {
      const missing = await route(new Request(`http://localhost/api/internal/${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      }));
      const wrong = await route(new Request(`http://localhost/api/internal/${path}`, {
        method: "POST", headers: { authorization: "Bearer wrong---shared-token-value", "content-type": "application/json" }, body: "{}",
      }));
      assert.equal(missing.status, 401);
      assert.equal(wrong.status, 401);
    }
    const nestedOnly = await providerApi(new Request("http://localhost/api/internal/providers/context", {
      method: "POST", headers: { authorization: `Bearer ${process.env.PROVIDER_BRIDGE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "cache.get", request: { contextRef: "00000000-0000-0000-0000-000000000000", namespace: "context", key: "x" } }),
    }));
    assert.equal(nestedOnly.status, 400);
  } finally {
    if (previous === undefined) delete process.env.PROVIDER_BRIDGE_TOKEN;
    else process.env.PROVIDER_BRIDGE_TOKEN = previous;
  }
});

test("browser RLS writes exclude service-owned file metadata", async () => {
  const [sql, security] = await Promise.all([
    readFile(new URL("supabase/migrations/20260825000000_harnest_ai.sql", root), "utf8"),
    readFile(new URL("supabase/migrations/20260826000000_v15_security_durability.sql", root), "utf8"),
  ]);
  const writePolicy = sql.match(/foreach table_name in array array\['conversations','messages'\][\s\S]*?end \$\$;/u)?.[0];
  assert.ok(writePolicy, "expected the narrow browser write-policy block");
  for (const protectedTable of ["files", "runs", "jobs", "events", "snapshots", "permission_grants", "context_refs", "rate_limit_buckets"]) {
    assert.doesNotMatch(writePolicy, new RegExp(`['\"]${protectedTable}['\"]`, "u"));
  }
  assert.match(sql, /drop policy if exists files_owner_update/u);
  assert.match(sql, /grant execute on function public\.lease_jobs[\s\S]*to service_role/u);
  assert.match(sql, /grant execute on function public\.renew_job_lease[\s\S]*to service_role/u);
  assert.match(sql, /grant execute on function public\.finish_job[\s\S]*to service_role/u);
  assert.match(security, /messages_owner_insert[\s\S]*role = 'user'[\s\S]*run_id is null/u);
  assert.match(security, /messages_owner_update[\s\S]*role = 'user'[\s\S]*run_id is null/u);
  assert.doesNotMatch(security, /grant execute on function public\.enqueue_chat[\s\S]*to authenticated/u);
  assert.match(security, /grant execute on function public\.enqueue_chat[\s\S]*to service_role/u);
  const upload = await readFile(new URL("app/api/files/route.ts", root), "utf8");
  assert.match(upload, /admin\.from\("files"\)\.insert/u);
});
