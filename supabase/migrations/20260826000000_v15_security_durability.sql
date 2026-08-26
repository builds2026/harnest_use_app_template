-- v1.5 durability and browser/server trust-boundary fixes.

-- Browser sessions may create/edit only genuine user messages. The service
-- role bypasses RLS and remains the sole writer for run projections.
drop policy if exists messages_owner_insert on public.messages;
drop policy if exists messages_owner_update on public.messages;
drop policy if exists messages_owner_delete on public.messages;
create policy messages_owner_insert on public.messages for insert
  with check (auth.uid() = user_id and role = 'user' and run_id is null);
create policy messages_owner_update on public.messages for update
  using (auth.uid() = user_id and role = 'user' and run_id is null)
  with check (auth.uid() = user_id and role = 'user' and run_id is null);
create policy messages_owner_delete on public.messages for delete
  using (auth.uid() = user_id and role = 'user' and run_id is null);

-- One terminal projection per run, and one durable copy of each run citation.
create unique index if not exists messages_terminal_assistant_idx
  on public.messages(run_id) where role = 'assistant' and run_id is not null;
create unique index if not exists citations_run_index_idx
  on public.citations(run_id, citation_index) where run_id is not null;

create table public.oauth_sessions (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique check (state_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null references public.runs(id) on delete cascade,
  interaction_id text not null check (char_length(interaction_id) between 1 and 200),
  connection_id uuid not null references public.connections(id) on delete cascade,
  redirect_uri text not null,
  expires_at timestamptz not null default now() + interval '10 minutes',
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index oauth_sessions_expiry_idx on public.oauth_sessions(expires_at);
alter table public.oauth_sessions enable row level security;
comment on table public.oauth_sessions is 'Server-only, one-time OAuth state bindings. No browser policy is intentional.';

create table public.run_command_receipts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  command_key text not null check (command_key ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (status in ('pending','accepted')),
  expires_at timestamptz not null default now() + interval '2 minutes',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id,command_key)
);
create unique index run_command_one_pending_idx on public.run_command_receipts(run_id) where status='pending';
alter table public.run_command_receipts enable row level security;
comment on table public.run_command_receipts is 'Server-only idempotency receipts for authenticated Run commands.';

-- Repair any duplicates created by the pre-v1.5 command path before enforcing
-- one queued/leased worker per Harnest Run.
with ranked as (
  select id,row_number() over(partition by run_id order by case status when 'leased' then 0 else 1 end,created_at) position
  from public.jobs where run_id is not null and kind='harnest-run' and status in ('queued','leased')
)
update public.jobs set status='cancelled',lease_owner=null,lease_expires_at=null,last_error='Duplicate active job removed by v1.5 migration'
where id in (select id from ranked where position>1);
create unique index jobs_one_active_harnest_run_idx on public.jobs(run_id)
  where run_id is not null and kind='harnest-run' and status in ('queued','leased');

alter table public.provider_file_uploads
  add column expected_size_bytes bigint check (expected_size_bytes between 1 and 33554432),
  add column expected_sha256 text check (expected_sha256 ~ '^[a-f0-9]{64}$'),
  add constraint provider_file_upload_expected_pair check ((expected_size_bytes is null)=(expected_sha256 is null));

create or replace function public.claim_provider_file_upload(
  p_provider_ref text,p_context_ref uuid,p_user_id uuid,p_size bigint,p_sha256 text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare upload provider_file_uploads%rowtype; artifact artifacts%rowtype;
begin
  if auth.role()<>'service_role' or p_provider_ref!~'^[a-f0-9]{36}$' or p_size not between 1 and 33554432 or p_sha256!~'^[a-f0-9]{64}$'
    then raise exception 'invalid file claim' using errcode='42501'; end if;
  select * into upload from provider_file_uploads where provider_ref=p_provider_ref and context_ref=p_context_ref and user_id=p_user_id for update;
  if not found or upload.status='failed' then return jsonb_build_object('status','missing'); end if;
  if upload.status='committed' then
    select * into artifact from artifacts where id=upload.artifact_id and user_id=p_user_id;
    if not found or artifact.size_bytes<>p_size or artifact.sha256<>p_sha256 then return jsonb_build_object('status','mismatch'); end if;
    return jsonb_build_object('status','committed','providerRef',upload.provider_ref,'name',artifact.name,'mimeType',artifact.mime_type,
      'size',artifact.size_bytes,'sha256',artifact.sha256,'metadata',artifact.metadata);
  end if;
  if upload.expected_sha256 is null then
    if upload.expires_at<=now() then return jsonb_build_object('status','missing'); end if;
    update provider_file_uploads set expected_size_bytes=p_size,expected_sha256=p_sha256 where provider_ref=p_provider_ref;
  elsif upload.expected_size_bytes<>p_size or upload.expected_sha256<>p_sha256 then
    return jsonb_build_object('status','mismatch');
  end if;
  return jsonb_build_object('status','ready','providerRef',upload.provider_ref,'name',upload.name,'mimeType',upload.mime_type,'metadata',upload.metadata);
end $$;
revoke all on function public.claim_provider_file_upload(text,uuid,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.claim_provider_file_upload(text,uuid,uuid,bigint,text) to service_role;

create or replace function public.finalize_provider_file_upload(
  p_provider_ref text,p_context_ref uuid,p_user_id uuid,p_storage_path text,p_size bigint,p_sha256 text,p_metadata jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare upload provider_file_uploads%rowtype; artifact artifacts%rowtype;
begin
  if auth.role()<>'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  select * into upload from provider_file_uploads where provider_ref=p_provider_ref and context_ref=p_context_ref and user_id=p_user_id for update;
  if not found or upload.expected_size_bytes<>p_size or upload.expected_sha256<>p_sha256 then return jsonb_build_object('status','mismatch'); end if;
  if upload.status='committed' then
    select * into artifact from artifacts where id=upload.artifact_id and user_id=p_user_id;
    if not found or artifact.size_bytes<>p_size or artifact.sha256<>p_sha256 then return jsonb_build_object('status','mismatch'); end if;
    return jsonb_build_object('status','committed','providerRef',upload.provider_ref,'name',artifact.name,'mimeType',artifact.mime_type,
      'size',artifact.size_bytes,'sha256',artifact.sha256,'metadata',artifact.metadata);
  end if;
  if upload.status<>'pending' then return jsonb_build_object('status','mismatch'); end if;
  insert into artifacts(user_id,conversation_id,storage_bucket,storage_path,name,kind,mime_type,size_bytes,sha256,metadata,status)
    values(p_user_id,upload.conversation_id,'artifacts',p_storage_path,upload.name,'file',upload.mime_type,p_size,p_sha256,upload.metadata||coalesce(p_metadata,'{}'),'ready')
    on conflict(storage_path) do nothing;
  select * into artifact from artifacts where storage_path=p_storage_path for update;
  if not found or artifact.user_id<>p_user_id or artifact.conversation_id<>upload.conversation_id or artifact.name<>upload.name
    or artifact.mime_type<>upload.mime_type or artifact.size_bytes<>p_size or artifact.sha256<>p_sha256 or artifact.status<>'ready'
    then return jsonb_build_object('status','mismatch'); end if;
  update provider_file_uploads set status='committed',artifact_id=artifact.id where provider_ref=p_provider_ref and status='pending';
  return jsonb_build_object('status','committed','providerRef',upload.provider_ref,'name',artifact.name,'mimeType',artifact.mime_type,
    'size',artifact.size_bytes,'sha256',artifact.sha256,'metadata',artifact.metadata);
end $$;
revoke all on function public.finalize_provider_file_upload(text,uuid,uuid,text,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.finalize_provider_file_upload(text,uuid,uuid,text,bigint,text,jsonb) to service_role;

create or replace function public.fail_provider_file_upload(
  p_provider_ref text,p_context_ref uuid,p_user_id uuid,p_storage_path text
) returns boolean language plpgsql security definer set search_path=public as $$
declare upload_id uuid;
begin
  if auth.role()<>'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  select artifact_id into upload_id from provider_file_uploads where provider_ref=p_provider_ref and context_ref=p_context_ref and user_id=p_user_id and status='pending' for update;
  if not found then return false; end if;
  delete from artifacts a where a.storage_path=p_storage_path and a.run_id is null
    and not exists(select 1 from provider_file_uploads u where u.artifact_id=a.id and u.status='committed');
  update provider_file_uploads set status='failed' where provider_ref=p_provider_ref and status='pending';
  return true;
end $$;
revoke all on function public.fail_provider_file_upload(text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fail_provider_file_upload(text,uuid,uuid,text) to service_role;

-- The user message, context capability, run, and job commit together or not at all.
create or replace function public.enqueue_chat(
  p_user_id uuid, p_conversation_id uuid, p_message text, p_file_ids uuid[], p_run_id uuid
) returns table(run_id uuid, context_ref uuid)
language plpgsql security definer set search_path = public as $$
declare context_id uuid := gen_random_uuid();
begin
  if auth.role() <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_message is null or char_length(btrim(p_message)) < 1 or char_length(p_message) > 32000 or octet_length(p_message) > 65536 then raise exception 'invalid message'; end if;
  if not exists (select 1 from conversations where id=p_conversation_id and user_id=p_user_id) then raise exception 'conversation is not owned by user' using errcode = '42501'; end if;
  if cardinality(coalesce(p_file_ids, '{}')) > 10 or exists (
    select 1 from unnest(coalesce(p_file_ids, '{}')) file_id
    where not exists (select 1 from files where id=file_id and user_id=p_user_id and conversation_id=p_conversation_id and status <> 'deleted')
  ) then raise exception 'file is not owned by conversation' using errcode = '42501'; end if;

  insert into messages(user_id,conversation_id,role,content,file_ids)
    values(p_user_id,p_conversation_id,'user',p_message,coalesce(p_file_ids,'{}'));
  insert into context_refs(id,user_id,conversation_id,file_ids,expires_at)
    values(context_id,p_user_id,p_conversation_id,coalesce(p_file_ids,'{}'),now()+interval '15 minutes');
  insert into runs(id,user_id,conversation_id,status,input)
    values(p_run_id,p_user_id,p_conversation_id,'queued',jsonb_build_object('contextRef',context_id));
  insert into jobs(user_id,conversation_id,run_id,kind,payload)
    values(p_user_id,p_conversation_id,p_run_id,'harnest-run',jsonb_build_object('message',p_message,'contextRef',context_id));
  return query select p_run_id, context_id;
end $$;
revoke all on function public.enqueue_chat(uuid,uuid,text,uuid[],uuid) from public, anon, authenticated;
grant execute on function public.enqueue_chat(uuid,uuid,text,uuid[],uuid) to service_role;

-- Refresh the capability from server-owned run/job bindings, including after a
-- long pause where its previous expiry is already in the past.
create or replace function public.refresh_run_context(p_run_id uuid, p_user_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare context_id uuid; refreshed boolean := false;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  select (payload->>'contextRef')::uuid into context_id from jobs
    where run_id=p_run_id and user_id=p_user_id and payload->>'contextRef' is not null
    order by created_at desc limit 1;
  update context_refs set expires_at=now()+interval '15 minutes'
    where id=context_id and user_id=p_user_id
      and conversation_id=(select conversation_id from runs where id=p_run_id and user_id=p_user_id);
  refreshed := found;
  if refreshed then
    update provider_file_uploads set expires_at=now()+interval '15 minutes'
      where context_ref=context_id and user_id=p_user_id and status='pending';
  end if;
  return refreshed;
exception when invalid_text_representation then return false;
end $$;
revoke all on function public.refresh_run_context(uuid,uuid) from public, anon, authenticated;
grant execute on function public.refresh_run_context(uuid,uuid) to service_role;

create or replace function public.begin_run_command(p_run_id uuid, p_user_id uuid, p_command_key text)
returns text language plpgsql security definer set search_path = public as $$
declare run_status text; receipt_status text;
begin
  if auth.role()<>'service_role' or p_command_key!~'^[a-f0-9]{64}$' then raise exception 'invalid command reservation' using errcode='42501'; end if;
  select status into run_status from runs where id=p_run_id and user_id=p_user_id for update;
  if not found then return 'missing'; end if;
  select status into receipt_status from run_command_receipts where run_id=p_run_id and command_key=p_command_key;
  if receipt_status='accepted' then return 'accepted'; end if;
  if run_status in ('succeeded','failed','cancelled') then return 'terminal'; end if;
  if receipt_status='pending' then return 'ready'; end if;
  if run_status<>'waiting' then return 'not_waiting'; end if;
  delete from run_command_receipts where run_id=p_run_id and status='pending' and expires_at<=now();
  if exists(select 1 from run_command_receipts where run_id=p_run_id and status='pending') then return 'busy'; end if;
  if not refresh_run_context(p_run_id,p_user_id) then return 'missing_context'; end if;
  insert into run_command_receipts(run_id,user_id,command_key) values(p_run_id,p_user_id,p_command_key);
  return 'ready';
end $$;
revoke all on function public.begin_run_command(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.begin_run_command(uuid,uuid,text) to service_role;

create or replace function public.accept_run_command(p_run_id uuid, p_user_id uuid, p_command_key text)
returns boolean language plpgsql security definer set search_path = public as $$
declare run_status text;
begin
  if auth.role()<>'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  select status into run_status from runs where id=p_run_id and user_id=p_user_id for update;
  if not found then return false; end if;
  if exists(select 1 from run_command_receipts where run_id=p_run_id and command_key=p_command_key and status='accepted') then return true; end if;
  if run_status<>'waiting' or not exists(select 1 from run_command_receipts where run_id=p_run_id and command_key=p_command_key and status='pending') then return false; end if;
  if not exists(select 1 from jobs where run_id=p_run_id and kind='harnest-run' and status in ('queued','leased')) then
    insert into jobs(user_id,conversation_id,run_id,kind,payload,priority,max_attempts,status)
      select p_user_id,conversation_id,p_run_id,kind,payload,priority,max_attempts,'queued'
      from jobs where run_id=p_run_id and kind='harnest-run' order by created_at desc limit 1;
    if not found then raise exception 'run has no resumable job'; end if;
  end if;
  update run_command_receipts set status='accepted',updated_at=now() where run_id=p_run_id and command_key=p_command_key and status='pending';
  update runs set status='running' where id=p_run_id and user_id=p_user_id and status='waiting';
  return true;
end $$;
revoke all on function public.accept_run_command(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.accept_run_command(uuid,uuid,text) to service_role;

create or replace function public.reject_run_command(p_run_id uuid, p_user_id uuid, p_command_key text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.role()<>'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  delete from run_command_receipts where run_id=p_run_id and user_id=p_user_id and command_key=p_command_key and status='pending';
  return found;
end $$;
revoke all on function public.reject_run_command(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.reject_run_command(uuid,uuid,text) to service_role;

-- Replaces the original selector: exhausted expired leases are terminalized,
-- and every newly active lease extends its owned context capability.
create or replace function public.lease_jobs(p_worker_id text, p_limit integer default 1, p_lease_seconds integer default 60)
returns setof public.jobs language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' or p_limit not between 1 and 25 or p_lease_seconds not between 10 and 900 then raise exception 'invalid lease request'; end if;

  with exhausted as (
    update jobs set status='failed', last_error=coalesce(last_error,'Job lease expired after maximum attempts'),
      lease_owner=null, lease_expires_at=null, updated_at=now()
    where status='leased' and lease_expires_at < now() and attempts >= max_attempts
    returning run_id
  )
  update runs set status='failed', error='Worker lease expired after maximum attempts', completed_at=now()
    where id in (select run_id from exhausted) and status not in ('succeeded','failed','cancelled');

  return query
  with candidates as (
    select id from jobs
    where attempts < max_attempts and available_at <= now()
      and (status='queued' or (status='leased' and lease_expires_at < now()))
    order by priority desc, created_at for update skip locked limit p_limit
  ), leased as (
    update jobs set status='leased', lease_owner=p_worker_id,
      lease_expires_at=now()+make_interval(secs=>p_lease_seconds), attempts=attempts+1, updated_at=now()
    where id in (select id from candidates) returning jobs.*
  ), refreshed as (
    update context_refs c set expires_at=now()+interval '15 minutes'
    from leased j where c.id=(j.payload->>'contextRef')::uuid and c.user_id=j.user_id
    returning c.id
  )
  select leased.* from leased;
end $$;
revoke all on function public.lease_jobs(text,integer,integer) from public, anon, authenticated;
grant execute on function public.lease_jobs(text,integer,integer) to service_role;

create or replace function public.renew_job_lease(p_job_id uuid, p_worker_id text, p_lease_seconds integer default 60)
returns boolean language plpgsql security definer set search_path = public as $$
declare leased jobs%rowtype;
begin
  if auth.role() <> 'service_role' or p_lease_seconds not between 10 and 900 then raise exception 'invalid lease renewal' using errcode = '42501'; end if;
  update jobs set lease_expires_at=now()+make_interval(secs=>p_lease_seconds), updated_at=now()
    where id=p_job_id and status='leased' and lease_owner=p_worker_id and lease_expires_at > now()
    returning * into leased;
  if not found then return false; end if;
  update context_refs set expires_at=now()+interval '15 minutes'
    where id=(leased.payload->>'contextRef')::uuid and user_id=leased.user_id;
  update provider_file_uploads set expires_at=now()+interval '15 minutes'
    where context_ref=(leased.payload->>'contextRef')::uuid and user_id=leased.user_id and status='pending';
  return true;
end $$;
revoke all on function public.renew_job_lease(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.renew_job_lease(uuid,text,integer) to service_role;

-- A lost HTTP acknowledgement after a committed terminal event must not turn
-- the already-succeeded run/job into a failure.
create or replace function public.finish_job(p_job_id uuid, p_worker_id text, p_succeeded boolean, p_error text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare finished_run_id uuid; finished_status text;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  update jobs j set
    status=case when p_succeeded or exists(select 1 from runs r where r.id=j.run_id and r.status in ('succeeded','cancelled')) then 'succeeded' else 'failed' end,
    last_error=case when p_succeeded or exists(select 1 from runs r where r.id=j.run_id and r.status in ('succeeded','cancelled')) then null else left(p_error,4000) end,
    lease_owner=null,lease_expires_at=null,updated_at=now()
  where j.id=p_job_id and j.status='leased' and j.lease_owner=p_worker_id and j.lease_expires_at>now()
  returning j.run_id,j.status into finished_run_id,finished_status;
  if not found then return false; end if;
  if finished_status='failed' then
    update runs set status='failed',error=coalesce(left(p_error,4000),'Worker failed'),completed_at=now()
      where id=finished_run_id and status in ('queued','running','waiting');
  end if;
  return true;
end $$;
revoke all on function public.finish_job(uuid,text,boolean,text) from public, anon, authenticated;
grant execute on function public.finish_job(uuid,text,boolean,text) to service_role;

-- Event insert and every derived projection share one transaction. Replays run
-- the projection again, repairing rows written by the pre-v1.5 two-phase path.
create or replace function public.persist_worker_event(
  p_job_id uuid, p_worker_id text, p_sequence integer, p_type text,
  p_status text, p_payload jsonb, p_projection jsonb default '{}'
) returns boolean language plpgsql security definer set search_path = public as $$
declare leased jobs%rowtype; assistant_id uuid; item jsonb; citation_number integer;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  select * into leased from jobs where id=p_job_id and status='leased' and lease_owner=p_worker_id and lease_expires_at>now() for update;
  if not found or leased.run_id is null or leased.conversation_id is null then raise exception 'job lease is invalid or expired'; end if;
  insert into events(user_id,conversation_id,run_id,sequence,type,status,payload)
    values(leased.user_id,leased.conversation_id,leased.run_id,p_sequence,p_type,p_status,p_payload)
    on conflict(run_id,sequence) do nothing;
  if not exists (select 1 from events where run_id=leased.run_id and sequence=p_sequence and type=p_type and payload->>'eventId'=p_payload->>'eventId')
    then raise exception 'event sequence collision'; end if;

  if p_type='run.snapshot' then
    insert into snapshots(user_id,conversation_id,run_id,revision,sequence,state)
      values(leased.user_id,leased.conversation_id,leased.run_id,coalesce((p_projection->>'revision')::integer,p_sequence),p_sequence,coalesce(p_projection->'state','{}'))
      on conflict(run_id,revision) do update set sequence=excluded.sequence,state=excluded.state;
  end if;
  if p_type in ('interaction.requested','run.paused') then update runs set status='waiting' where id=leased.run_id; end if;
  if p_type='run.cancelled' then update runs set status='cancelled',completed_at=coalesce(completed_at,now()) where id=leased.run_id; end if;
  if p_type='run.failed' then update runs set status='failed',error=coalesce(p_projection->>'error','Harnest run failed'),completed_at=coalesce(completed_at,now()) where id=leased.run_id; end if;

  if p_type='citations' then
    for item in select value from jsonb_array_elements(coalesce(p_projection->'citations','[]')) loop
      citation_number := nullif(regexp_replace(coalesce(item->>'label',''),'\D','','g'),'')::integer;
      if citation_number is not null and citation_number > 0 then
        insert into citations(user_id,conversation_id,run_id,citation_index,title,url,metadata)
          values(leased.user_id,leased.conversation_id,leased.run_id,citation_number,
            coalesce(item#>>'{provenance,title}',item->>'label'),item#>>'{provenance,uri}',item)
          on conflict(run_id,citation_index) where run_id is not null
          do update set title=excluded.title,url=excluded.url,metadata=excluded.metadata;
      end if;
    end loop;
  end if;

  if p_type in ('artifact','artifact.created','artifact.updated','run.completed') then
    for item in select value from jsonb_array_elements(coalesce(p_projection->'artifacts','[]')) loop
      update artifacts set run_id=leased.run_id,metadata=metadata||jsonb_build_object('harnestRef',item->>'ref')
        where user_id=leased.user_id and conversation_id=leased.conversation_id and run_id is null
          and name=item->>'name' and sha256=item->>'sha256';
    end loop;
  end if;

  if p_type='run.completed' then
    update runs set status='succeeded',output=p_projection->'output',usage=coalesce(p_projection->'usage','{}'),
      cost_usd=nullif(p_projection->>'costUsd','')::numeric,completed_at=coalesce(completed_at,now()) where id=leased.run_id;
    insert into messages(user_id,conversation_id,run_id,role,content)
      values(leased.user_id,leased.conversation_id,leased.run_id,'assistant',left(coalesce(p_projection->>'content','null'),16384))
      on conflict(run_id) where role='assistant' and run_id is not null do update set content=excluded.content
      returning id into assistant_id;
    update citations set message_id=assistant_id where run_id=leased.run_id;
  end if;
  return true;
end $$;
revoke all on function public.persist_worker_event(uuid,text,integer,text,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.persist_worker_event(uuid,text,integer,text,text,jsonb,jsonb) to service_role;

create or replace function public.claim_oauth_session(p_state_hash text, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare claimed oauth_sessions%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  update oauth_sessions set consumed_at=now() where state_hash=p_state_hash and user_id=p_user_id
    and consumed_at is null and expires_at>now() returning * into claimed;
  if not found then return null; end if;
  return jsonb_build_object('id',claimed.id,'runId',claimed.run_id,'interactionId',claimed.interaction_id,
    'connectionId',claimed.connection_id,'redirectUri',claimed.redirect_uri);
end $$;
revoke all on function public.claim_oauth_session(text,uuid) from public, anon, authenticated;
grant execute on function public.claim_oauth_session(text,uuid) to service_role;

create or replace function public.store_oauth_connection_secret(p_connection_id uuid, p_user_id uuid, p_secret text)
returns text language plpgsql security definer set search_path = public, vault as $$
declare secret_id uuid; connection_name text;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  select vault_secret_id,name into secret_id,connection_name from public.connections
    where id=p_connection_id and user_id=p_user_id for update;
  if not found then raise exception 'connection is not owned by user' using errcode = '42501'; end if;
  if secret_id is null then
    secret_id := vault.create_secret(p_secret,'oauth-'||p_connection_id::text,'App-owned OAuth credential');
  else
    perform vault.update_secret(secret_id,p_secret,'oauth-'||p_connection_id::text,'App-owned OAuth credential');
  end if;
  update public.connections set vault_secret_id=secret_id,status='ready',last_error=null where id=p_connection_id;
  return 'connection:'||p_connection_id::text;
end $$;
revoke all on function public.store_oauth_connection_secret(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.store_oauth_connection_secret(uuid,uuid,text) to service_role;
