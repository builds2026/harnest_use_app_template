-- Data API roles receive only the operations used by this application.
-- RLS remains the row boundary; these grants remove privileges that bypass it
-- (notably TRUNCATE) and make service-only tables read-only to browsers.
revoke all on all tables in schema public from anon, authenticated;

grant select on table
  public.artifacts,
  public.cache_entries,
  public.citations,
  public.connections,
  public.context_refs,
  public.conversations,
  public.events,
  public.files,
  public.jobs,
  public.memories,
  public.messages,
  public.permission_grants,
  public.pkm_chunks,
  public.pkm_sources,
  public.rate_limit_buckets,
  public.runs,
  public.snapshots
to authenticated;

grant insert, update, delete on table public.conversations, public.messages
to authenticated;

grant all on all tables in schema public to service_role;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  grant all on tables to service_role;
