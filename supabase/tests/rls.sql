begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

select ok(
  not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  ),
  'every public application table has RLS enabled'
);

select ok(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'anon'
  ),
  'anonymous users have no direct application-table privileges'
);

select ok(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'authenticated'
      and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')
  ),
  'authenticated users cannot truncate or alter table behavior'
);

select ok(
  has_table_privilege('authenticated', 'public.conversations', 'SELECT,INSERT,UPDATE,DELETE')
  and has_table_privilege('authenticated', 'public.messages', 'SELECT,INSERT,UPDATE,DELETE'),
  'authenticated users retain the two browser-owned write surfaces'
);

select ok(
  not has_table_privilege('authenticated', 'public.runs', 'INSERT,UPDATE,DELETE')
  and not has_table_privilege('authenticated', 'public.connections', 'INSERT,UPDATE,DELETE')
  and has_table_privilege('service_role', 'public.runs', 'SELECT,INSERT,UPDATE,DELETE'),
  'run and connection mutations remain service-only'
);

insert into auth.users (id, email, aud, role, encrypted_password, created_at, updated_at)
values
  ('10000000-0000-0000-0000-000000000001', 'one@example.test', 'authenticated', 'authenticated', '', now(), now()),
  ('20000000-0000-0000-0000-000000000002', 'two@example.test', 'authenticated', 'authenticated', '', now(), now());
insert into public.conversations (id, user_id, title)
values
  ('10000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001', 'owned'),
  ('20000000-0000-0000-0000-000000000022', '20000000-0000-0000-0000-000000000002', 'other');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is((select count(*) from public.conversations), 1::bigint, 'a user reads only owned conversations');
select lives_ok(
  $$insert into public.conversations (user_id, title) values ('10000000-0000-0000-0000-000000000001', 'new owned')$$,
  'a user may create an owned conversation'
);
select throws_ok(
  $$insert into public.conversations (user_id, title) values ('20000000-0000-0000-0000-000000000002', 'cross-user')$$,
  '42501',
  'new row violates row-level security policy for table "conversations"',
  'a user cannot create data for another user'
);
reset role;

select * from finish();
rollback;
