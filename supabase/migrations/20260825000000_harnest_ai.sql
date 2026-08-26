-- Harnest AI service data boundary. Apply with `supabase db push`.
-- Every browser-visible row is owned by auth.uid(). Only the Next server uses
-- the service role and audited RPCs; the separate worker has no DB credential.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New conversation' check (char_length(title) between 1 and 200),
  status text not null default 'active' check (status in ('active','archived','deleted')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_user_updated_idx on public.conversations(user_id, updated_at desc);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  external_run_id text,
  status text not null default 'queued' check (status in ('queued','running','waiting','succeeded','failed','cancelled')),
  input jsonb not null default '{}',
  output jsonb,
  error text,
  usage jsonb not null default '{}',
  cost_usd numeric(14,6),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index runs_conversation_created_idx on public.runs(conversation_id, created_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  run_id uuid references public.runs(id) on delete set null,
  role text not null check (role in ('user','assistant','system','tool')),
  content text not null check (octet_length(content) <= 65536),
  file_ids uuid[] not null default '{}',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index messages_conversation_created_idx on public.messages(conversation_id, created_at);

create table public.files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  storage_bucket text not null default 'user-files',
  storage_path text not null unique,
  name text not null check (char_length(name) between 1 and 512),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes between 1 and 20971520),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (status in ('pending','ready','indexing','indexed','rejected','deleted')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index files_user_created_idx on public.files(user_id, created_at desc);

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  run_id uuid references public.runs(id) on delete cascade,
  storage_bucket text not null default 'artifacts',
  storage_path text not null unique,
  name text not null check (char_length(name) between 1 and 512),
  kind text not null default 'file',
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  summary text,
  status text not null default 'ready' check (status in ('creating','ready','rejected','deleted')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index artifacts_run_created_idx on public.artifacts(run_id, created_at);

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  key text not null check (key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  value jsonb not null check (octet_length(value::text) <= 65536),
  provenance jsonb not null default '{"source":"host"}' check (octet_length(provenance::text) <= 65536),
  scope text not null default 'user' check (scope in ('user','conversation')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct(user_id, conversation_id, key)
);
create index memories_user_updated_idx on public.memories(user_id, updated_at desc);

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('provider','pkm','mcp','api','storage')),
  name text not null check (char_length(name) between 1 and 200),
  public_config jsonb not null default '{}',
  vault_secret_id uuid,
  status text not null default 'pending' check (status in ('pending','ready','error','revoked')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index connections_user_name_idx on public.connections(user_id, name);
comment on column public.connections.vault_secret_id is 'Opaque Supabase Vault secret id. Never return decrypted_secret to a browser, event, trace, or job payload.';

create table public.pkm_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references public.connections(id) on delete set null,
  title text not null check (char_length(title) between 1 and 300),
  kind text not null,
  external_ref text,
  status text not null default 'pending' check (status in ('pending','syncing','synced','error','disabled')),
  cursor jsonb not null default '{}',
  metadata jsonb not null default '{}',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pkm_sources_user_updated_idx on public.pkm_sources(user_id, updated_at desc);

create table public.pkm_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.pkm_sources(id) on delete cascade,
  external_ref text,
  content text not null check (octet_length(content) <= 1048576),
  content_hash text not null,
  embedding vector(1536),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_id, content_hash)
);
create index pkm_chunks_source_idx on public.pkm_chunks(source_id);
create index pkm_chunks_embedding_idx on public.pkm_chunks using hnsw (embedding vector_cosine_ops);

create table public.citations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete cascade,
  run_id uuid references public.runs(id) on delete cascade,
  chunk_id uuid references public.pkm_chunks(id) on delete set null,
  citation_index integer not null check (citation_index > 0),
  title text not null,
  url text,
  excerpt text check (char_length(excerpt) <= 4000),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(message_id, citation_index)
);
create index citations_conversation_idx on public.citations(conversation_id, citation_index);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  run_id uuid not null references public.runs(id) on delete cascade,
  sequence integer not null check (sequence > 0),
  type text not null,
  status text not null default 'complete' check (status in ('queued','running','waiting','complete','failed','cancelled')),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(run_id, sequence)
);
create index events_run_sequence_idx on public.events(run_id, sequence);

create table public.snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  run_id uuid not null references public.runs(id) on delete cascade,
  revision integer not null check (revision >= 0),
  sequence integer not null default 0,
  state jsonb not null,
  created_at timestamptz not null default now(),
  unique(run_id, revision)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  run_id uuid references public.runs(id) on delete cascade,
  kind text not null check (kind in ('harnest-run','file-index','pkm-sync','cleanup')),
  payload jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued','leased','succeeded','failed','cancelled')),
  priority smallint not null default 0,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 20),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_lease_idx on public.jobs(status, available_at, priority desc, created_at) where status in ('queued','leased');

create table public.permission_grants (
  id uuid primary key default gen_random_uuid(),
  provider_ref text not null default encode(gen_random_bytes(18), 'hex') unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references public.connections(id) on delete cascade,
  harness_id text not null,
  tool_id text not null,
  connection_ref text not null default '',
  capability text not null check (capability in ('workspace-write','process','network')),
  resource_scope text not null default '',
  effect text not null default 'allow_always' check (effect = 'allow_always'),
  expires_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, harness_id, tool_id, capability, connection_ref, resource_scope)
);

create table public.cache_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  namespace text not null,
  key_hash text not null,
  value jsonb not null,
  etag text not null,
  size_bytes integer not null check (size_bytes between 0 and 1048576),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, namespace, key_hash),
  check (namespace in ('context','provider-prompt'))
);
create index cache_expiry_idx on public.cache_entries(expires_at);

create table public.context_refs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  file_ids uuid[] not null default '{}',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index context_refs_expiry_idx on public.context_refs(expires_at);

create table public.provider_file_uploads (
  provider_ref text primary key default encode(gen_random_bytes(18), 'hex'),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  context_ref uuid not null references public.context_refs(id) on delete cascade,
  artifact_id uuid references public.artifacts(id) on delete set null,
  name text not null check (char_length(name) between 1 and 255),
  mime_type text not null,
  metadata jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending','committed','failed')),
  expires_at timestamptz not null default now() + interval '15 minutes',
  created_at timestamptz not null default now()
);

create table public.rate_limit_buckets (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  count integer not null default 0,
  reset_at timestamptz not null,
  primary key(user_id, key)
);

-- Same-user consistency guards prevent forged cross-tenant foreign keys even
-- when a caller legitimately owns some rows in each table.
create or replace function public.enforce_owned_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.conversation_id is not null and not exists (
    select 1 from conversations where id = new.conversation_id and user_id = new.user_id
  ) then raise exception 'conversation is not owned by user' using errcode = '42501'; end if;
  return new;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array['runs','messages','files','artifacts','memories','citations','events','snapshots','jobs','context_refs'] loop
    execute format('create trigger %I_owned_conversation before insert or update on public.%I for each row execute function public.enforce_owned_conversation()', table_name, table_name);
  end loop;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array['conversations','files','artifacts','memories','connections','pkm_sources','pkm_chunks','jobs','permission_grants','cache_entries'] loop
    execute format('create trigger %I_updated_at before update on public.%I for each row execute function public.set_updated_at()', table_name, table_name);
  end loop;
end $$;

-- Browser sessions may read only their rows. Product mutations are limited to
-- conversations, messages, and file metadata; privileged run orchestration,
-- approvals, cache, and provider state is owned by the Next server.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'conversations','runs','messages','files','artifacts','memories','connections',
    'pkm_sources','pkm_chunks','citations','events','snapshots','jobs',
    'permission_grants','cache_entries','context_refs','rate_limit_buckets'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('create policy %I_owner_select on public.%I for select using (auth.uid() = user_id)', table_name, table_name);
  end loop;
end $$;

alter table public.provider_file_uploads enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array['conversations','messages'] loop
    execute format('create policy %I_owner_insert on public.%I for insert with check (auth.uid() = user_id)', table_name, table_name);
    execute format('create policy %I_owner_update on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', table_name, table_name);
    execute format('create policy %I_owner_delete on public.%I for delete using (auth.uid() = user_id)', table_name, table_name);
  end loop;
end $$;

-- File metadata is written only by the authenticated upload BFF after it has
-- created an owner-prefixed private Storage object. Browser roles remain read-only.
drop policy if exists files_owner_insert on public.files;
drop policy if exists files_owner_update on public.files;
drop policy if exists files_owner_delete on public.files;

create or replace function public.consume_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare allowed boolean := false; actor uuid := auth.uid();
begin
  if actor is null or p_key !~ '^[a-z][a-z0-9._-]{0,63}$' or p_limit not between 1 and 10000 or p_window_seconds not between 1 and 86400 then return false; end if;
  insert into rate_limit_buckets(user_id, key, count, reset_at)
    values(actor, p_key, 1, now() + make_interval(secs => p_window_seconds))
  on conflict(user_id, key) do update set
    count = case when rate_limit_buckets.reset_at <= now() then 1 else rate_limit_buckets.count + 1 end,
    reset_at = case when rate_limit_buckets.reset_at <= now() then now() + make_interval(secs => p_window_seconds) else rate_limit_buckets.reset_at end
  where rate_limit_buckets.reset_at <= now() or rate_limit_buckets.count < p_limit
  returning true into allowed;
  return coalesce(allowed, false);
end $$;
revoke all on function public.consume_rate_limit(text, integer, integer) from public;
grant execute on function public.consume_rate_limit(text, integer, integer) to authenticated;

create or replace function public.lease_jobs(p_worker_id text, p_limit integer default 1, p_lease_seconds integer default 60)
returns setof public.jobs language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' or p_limit not between 1 and 25 or p_lease_seconds not between 10 and 900 then raise exception 'invalid lease request'; end if;
  return query
  with candidates as (
    select id from jobs
    where attempts < max_attempts and available_at <= now()
      and (status = 'queued' or (status = 'leased' and lease_expires_at < now()))
    order by priority desc, created_at
    for update skip locked limit p_limit
  )
  update jobs set status='leased', lease_owner=p_worker_id, lease_expires_at=now()+make_interval(secs => p_lease_seconds), attempts=attempts+1, updated_at=now()
  where id in (select id from candidates) returning jobs.*;
end $$;
revoke all on function public.lease_jobs(text, integer, integer) from public, anon, authenticated;
grant execute on function public.lease_jobs(text, integer, integer) to service_role;

create or replace function public.finish_job(p_job_id uuid, p_worker_id text, p_succeeded boolean, p_error text default null)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  update jobs set status=case when p_succeeded then 'succeeded' else 'failed' end,
    last_error=left(p_error, 4000), lease_owner=null, lease_expires_at=null, updated_at=now()
  where id=p_job_id and status='leased' and lease_owner=p_worker_id and lease_expires_at > now();
  return found;
end $$;
revoke all on function public.finish_job(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.finish_job(uuid, text, boolean, text) to service_role;

create or replace function public.renew_job_lease(p_job_id uuid, p_worker_id text, p_lease_seconds integer default 60)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' or p_lease_seconds not between 10 and 900 then raise exception 'invalid lease renewal' using errcode = '42501'; end if;
  update jobs set lease_expires_at=now()+make_interval(secs => p_lease_seconds), updated_at=now()
  where id=p_job_id and status='leased' and lease_owner=p_worker_id and lease_expires_at > now();
  return found;
end $$;
revoke all on function public.renew_job_lease(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.renew_job_lease(uuid, text, integer) to service_role;

create or replace function public.read_connection_secret(p_connection_id uuid)
returns text language plpgsql security definer set search_path = public, vault as $$
declare value text;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  select decrypted_secret into value from vault.decrypted_secrets
  where id = (select vault_secret_id from public.connections where id = p_connection_id);
  return value;
end $$;
revoke all on function public.read_connection_secret(uuid) from public, anon, authenticated;
grant execute on function public.read_connection_secret(uuid) to service_role;

-- Private Storage buckets. File bytes never live in relational rows.
insert into storage.buckets(id, name, public, file_size_limit)
values ('user-files','user-files',false,20971520), ('artifacts','artifacts',false,104857600)
on conflict(id) do update set public=false;

create policy user_files_read on storage.objects for select to authenticated
using (bucket_id='user-files' and (storage.foldername(name))[1]=auth.uid()::text);
create policy user_files_insert on storage.objects for insert to authenticated
with check (bucket_id='user-files' and (storage.foldername(name))[1]=auth.uid()::text);
create policy user_files_delete on storage.objects for delete to authenticated
using (bucket_id='user-files' and (storage.foldername(name))[1]=auth.uid()::text);
create policy artifacts_read on storage.objects for select to authenticated
using (bucket_id='artifacts' and (storage.foldername(name))[1]=auth.uid()::text);

comment on table public.connections is 'Public connection metadata only. Store credentials in Supabase Vault from trusted server code and retain only vault_secret_id here.';
comment on table public.events is 'Bounded, redacted Harnest events. Never persist credentials, raw private file bytes, or hidden model reasoning.';
