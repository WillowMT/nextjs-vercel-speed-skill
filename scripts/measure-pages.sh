#!/usr/bin/env bash
# Time page loads against a running production build, cold and warm.
#
#   BASE=http://localhost:3000 EMAIL=you@example.com PASSWORD=secret \
#     bash measure-pages.sh / /orders /payments
#
# Sign-in assumes a Better Auth email/password endpoint. For another auth
# system, drop it a cookie jar with your own flow and pass JAR=/path/cookies.txt.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
JAR="${JAR:-/tmp/perf-cookies.txt}"
EMAIL="${EMAIL:-}"
PASSWORD="${PASSWORD:-}"
SIGN_IN_PATH="${SIGN_IN_PATH:-/api/auth/sign-in/email}"
RUNS="${RUNS:-5}"

if [ "$#" -eq 0 ]; then
  set -- /
fi

if [ -n "$EMAIL" ] && [ -n "$PASSWORD" ]; then
  rm -f "$JAR"
  code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" \
    -X POST "$BASE$SIGN_IN_PATH" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
  echo "sign-in: HTTP $code ($JAR)"
  case "$code" in
    200) ;;
    401|403) echo "sign-in rejected — credentials, or the account is blocked" >&2 ;;
    *) echo "sign-in returned $code; pages will probably redirect to the login form" >&2 ;;
  esac
fi

printf '%-28s %10s %10s %8s\n' PATH FIRST_WARM BEST_WARM STATUS

for path in "$@"; do
  first=$(curl -s -o /dev/null -b "$JAR" -w '%{time_starttransfer} %{http_code}' "$BASE$path")
  status=${first##* }
  first=${first%% *}
  best=999
  for _ in $(seq 1 "$RUNS"); do
    t=$(curl -s -o /dev/null -b "$JAR" -w '%{time_starttransfer}' "$BASE$path")
    best=$(awk -v a="$best" -v b="$t" 'BEGIN{print (b<a)?b:a}')
  done
  awk -v p="$path" -v f="$first" -v b="$best" -v s="$status" \
    'BEGIN{printf "%-28s %8.1fms %8.1fms %8s\n", p, f*1000, b*1000, s}'
done

cat <<'NOTE'

Cold start: restart the server (or deploy) and measure the FIRST request only —
it carries module init plus the first database handshake. Warm numbers hide both.
A warm number that jumped by roughly one database round trip usually means the
session cookie cache expired, not that the page got slower.
NOTE
