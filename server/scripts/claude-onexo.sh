#!/usr/bin/env bash
# `claude` in your terminal, logged in with OneXO: every model call goes through the OneXO AI
# gateway (Kong /llm/anthropic → Connectra) with the token from the POC's `/login` → OneXO.
# Needs the POC server running. Extra args pass through: claude-onexo.sh -p "hi", --resume, …
set -eu
HELPER="$(cd "$(dirname "$0")" && pwd)/onexo-token.sh"
export ANTHROPIC_BASE_URL="${ONEXO_LLM_URL_HOST:-http://127.0.0.1:8000/llm}/anthropic"
export ANTHROPIC_CUSTOM_HEADERS="X-Onexo-Correlation-Id: cli-$(uuidgen | tr 'A-Z' 'a-z')"
export CLAUDE_CODE_API_KEY_HELPER_TTL_MS="${CLAUDE_CODE_API_KEY_HELPER_TTL_MS:-600000}"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# A key or token already in the environment would take precedence over the helper.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX
exec claude --settings "{\"apiKeyHelper\": \"$HELPER\"}" "$@"
