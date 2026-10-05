#!/usr/bin/env bash
# apiKeyHelper for a terminal `claude`: prints the POC user's current OneXO access token,
# fetched from the running POC server (which owns refreshing it). Used by claude-onexo.sh.
set -u
SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SECRET_FILE="${POC_CLI_SECRET_FILE:-$SERVER_DIR/.cli-secret}"
POC_URL="${POC_URL:-http://127.0.0.1:8091}"

if [ ! -r "$SECRET_FILE" ]; then
  echo "onexo-token: $SECRET_FILE not found — start the POC server once (it creates it)" >&2
  exit 1
fi
out="$(curl -s --max-time 15 -w '\n%{http_code}' -H "authorization: Bearer $(cat "$SECRET_FILE")" "$POC_URL/internal/cli-token")" || {
  echo "onexo-token: POC server not reachable at $POC_URL — is it running?" >&2
  exit 1
}
code="${out##*$'\n'}"
body="${out%$'\n'*}"
if [ "$code" != "200" ]; then
  echo "onexo-token: $body (HTTP $code)" >&2
  exit 1
fi
printf '%s' "$body"
