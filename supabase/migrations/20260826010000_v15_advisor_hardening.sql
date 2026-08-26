-- Supabase projects may have default function grants for API roles. Keep the
-- authenticated rate-limit RPC, but remove anonymous and direct trigger calls.
revoke all on function public.consume_rate_limit(text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_rate_limit(text, integer, integer)
  to authenticated, service_role;

revoke all on function public.enforce_owned_conversation()
  from public, anon, authenticated, service_role;
