# Arc — standalone Harnest AI service example

A working Next.js 16 + React 19 + Base UI service surface. Supabase owns identity, row authorization, files, durable runs, jobs, memory, PKM data, citations, permissions, cache metadata, and connection metadata. Only the Next server uses the Supabase service role; the separate Harnest worker has no database credentials or database client.

## Run the explicit local development path

```bash
npm install
cp .env.example .env.local
# set NEXT_PUBLIC_LOCAL_DEMO=true
npm run dev
```

The amber banner is intentional: this path is deterministic UI development only. It does not imply that Supabase, a model, a tool, PKM retrieval, or Harnest executed. Production never falls back to it.

## Production setup

1. Create a Supabase project, enable an Auth email provider, and add `http://localhost:3000/auth/callback` (plus the deployed callback) to the Auth redirect allowlist.
2. Link the Supabase CLI and run `supabase db push`. The migration creates the schema, RLS, private Storage buckets, rate limiter, and safe `SKIP LOCKED` job leases.
3. Copy `.env.example` to `.env.local`; set the Supabase URL and anon key. Keep `NEXT_PUBLIC_LOCAL_DEMO=false`.
4. Run the reviewed Harnest spec as a separate service. The script loads the ignored `.env.local`; its HTTP HostProvider adapter consumes the internal provider URL and bearer without placing either in graph input, events, or trace:

   ```bash
   npm run harnest
   ```

5. Set `APP_ORIGIN` to the exact public HTTPS origin (or local loopback origin), and register `${APP_ORIGIN}/oauth/callback` with each OAuth provider. Set `HARNEST_URL=http://127.0.0.1:8787`. If a gateway protects it, set the server-only `HARNEST_TOKEN`. Set `HARNEST_PUBLIC_NODE_ID=answer` when changing the example's final public Agent node.
6. Configure Harnest's reviewed HTTP HostProvider adapter with `HARNEST_PROVIDER_URL` and `HARNEST_PROVIDER_TOKEN` (the same secret held by Next as `PROVIDER_BRIDGE_TOKEN`). It receives only a short-lived opaque `contextRef`. The bridge implements the Conversation/Memory/Cache/File/Connection/Permission provider operations with revision or ETag conflicts and per-page bounds, so Harnest—not the app—chooses pages using the model/run context budget. Opaque file refs are dereferenced through the authenticated `/api/internal/providers/files/:ref` Range endpoint and verified against their stored SHA-256. Connection fetch/execute stays in the Next bridge: it enforces the configured HTTPS origin/path, injects a Vault credential server-side, and returns only bounded response bytes.
7. Start `npm run dev`, `npm run harnest`, and `npm run worker` in separate terminals. The Worker script loads ignored `worker/.env` and receives only the internal app URL/shared token and Harnest URL/token; it never receives the service role. Production chat intentionally waits for it instead of falling back to an in-process model call.

Required external credentials for a real run depend on the connections referenced by `harnest.example.yaml`: a model provider, search provider, and a reviewed isolated Code Runner. Configure them in the selected host connection backend, never in the spec; this reference bridge keeps public connection metadata in Supabase and credential material in Vault. The Next server requires the Supabase URL, anon key, and service role; the worker must never receive the service role.

## Boundary

```text
Browser ──session/RLS──> Next route ──Supabase HTTP──> Supabase Auth/PostgREST/Storage
                              └──browser SSE polls committed run events

Node worker ──opaque job/context refs + shared Bearer──> Next internal API
     └──@harnestai/sdk v1 HTTP/SSE──> Harnest runtime       └──lease/persist via Supabase
```

`POST /api/chat` authenticates, checks owned file references, creates a short-lived `contextRef`, and enqueues a durable job. The Next-owned internal worker API leases jobs and persists public events, snapshots, messages, and terminal state. The separate worker sees only opaque job/context references and uses the published `@harnestai/sdk` package for `create()` and reconnectable `events(after)`. Paused jobs keep renewing and reconnect from the last sequence. If Harnest restarts, the app persists a fresh resume idempotency key before recreating the active handle; a worker crash reuses that pending key instead of duplicating the resume. `/api/state` plus the owned run replay route restore an interaction after a browser reload. Browser SSE replays only committed Supabase events; only `HARNEST_PUBLIC_NODE_ID` deltas reach it, and `run.completed.data.output` is authoritative. Planner, classifier, tool payloads, and private state stay out of the projection.

Interaction responses and cancellations go through the authenticated command route and the same SDK's `respond()`, `command()`, and `cancel()` calls. Stable sequence numbers make reconnect/replay safe, while SQL `SKIP LOCKED` leases and renewals prevent concurrent job ownership.
All six interaction kinds are rendered: select, input, closed-schema form, verified file, same-origin OAuth completion, and permission. For an OAuth interaction, create an owned `connections` row whose `name` matches the interaction `elicitationId`. Its non-secret `public_config.oauth` supplies `authorizationUrl`, `tokenUrl`, `clientId`, optional `scopes`/`authorizationParams`, and `tokenAuthMethod`; put any client secret in Vault. The app creates and consumes one-time state, exchanges the code server-side, and replaces the Vault value with the app-owned token set. Persistent `allow_always` grants remain host-owned and can be reviewed or revoked from the Permissions tab.

## Storage and Vault

- `user-files` and `artifacts` are private buckets. Object paths must begin with the authenticated user's UUID. Use short-lived signed URLs for downloads; never make either bucket public.
- File bytes stay in Storage. Relational tables contain ownership, MIME, size, hash, and object references only.
- `connections.public_config` may hold non-secret endpoint/model settings. Create secrets from trusted server code with Supabase Vault and store only the resulting `vault_secret_id`. Never select `vault.decrypted_secrets` into browser responses, jobs, events, snapshots, logs, or Harnest input.
- The service role is Next-server-only. Never provide it to the worker, prefix it with `NEXT_PUBLIC_`, place it in client variables, or use it from a Client Component.
- Harnest never owns product OAuth credentials in this deployment. The app owns the authorization-code flow and stores product client/token credentials in Supabase Vault; Harnest receives only the opaque completed `connectionRef`. Harnest's own gateway token, if configured, remains server-to-server infrastructure authentication.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

The migrations keep browser policy separate from service-only transactional enqueue, event projection, lease, and OAuth RPCs. Add retention/partition maintenance only when real volume requires it.
