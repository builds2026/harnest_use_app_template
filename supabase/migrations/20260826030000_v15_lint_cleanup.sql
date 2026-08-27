create or replace function public.fail_provider_file_upload(
  p_provider_ref text,p_context_ref uuid,p_user_id uuid,p_storage_path text
) returns boolean language plpgsql security definer set search_path=public as $$
begin
  if auth.role()<>'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  perform 1 from provider_file_uploads where provider_ref=p_provider_ref and context_ref=p_context_ref and user_id=p_user_id and status='pending' for update;
  if not found then return false; end if;
  delete from artifacts a where a.storage_path=p_storage_path and a.run_id is null
    and not exists(select 1 from provider_file_uploads u where u.artifact_id=a.id and u.status='committed');
  update provider_file_uploads set status='failed' where provider_ref=p_provider_ref and status='pending';
  return true;
end $$;
revoke all on function public.fail_provider_file_upload(text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fail_provider_file_upload(text,uuid,uuid,text) to service_role;

create or replace function public.store_oauth_connection_secret(p_connection_id uuid, p_user_id uuid, p_secret text)
returns text language plpgsql security definer set search_path = public, vault as $$
declare secret_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  select vault_secret_id into secret_id from public.connections
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
