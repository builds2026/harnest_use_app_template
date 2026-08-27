#!/usr/bin/env bash
set -euo pipefail

npx supabase start >/dev/null
eval "$(npx supabase status -o env)"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY"
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export NEXT_PUBLIC_LOCAL_DEMO=false
export AUTH_AUTO_CONFIRM=true
export HARNEST_URL=http://127.0.0.1:8787
export NEXT_DIST_DIR=.next-e2e
npx playwright test
