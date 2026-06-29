#!/usr/bin/env bash
# Source this (don't run it) once per dev shell to load DSM creds from 1Password
# into the environment for the dev harness (deploy.ts, verify-tools.ts):
#
#   source dev/source-creds.sh
#
# Auth uses your existing `op` setup:
#   • Interactive: the 1Password desktop-app integration (biometric; ~10-min
#     rolling session per terminal — standard op behaviour).
#   • Headless / mobile / CI: set OP_SERVICE_ACCOUNT_TOKEN (e.g. from
#     dev/.env.local) and reads become prompt-free. We inject it into op only —
#     never re-export it — so child processes (tsx, docker, the server) don't
#     inherit vault access.
#
# Machine-specific values (real NAS URL, how you source the token) go in
# dev/.env.local (gitignored), sourced first so it wins.

_self_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
[ -n "$_self_dir" ] && [ -f "${_self_dir}/.env.local" ] && . "${_self_dir}/.env.local"

# Capture the optional service-account token and drop it from the environment
# immediately — before any external command (mkdir, op, …) runs — so no child
# process ever inherits it. It is injected into op only, in _op below.
_optok="${OP_SERVICE_ACCOUNT_TOKEN:-}"
unset OP_SERVICE_ACCOUNT_TOKEN

: "${DSM_OP_VAULT:=Claude}"
: "${DSM_OP_ITEM:=Synology DSM}"
: "${DSM_BASE_URL:=https://nas.local:5001}"
: "${DSM_USER:=claude-mcp}"
# Local audit fallback (used only when MCP_AUDIT_URL is unset); the canonical
# log lives on the NAS via the daemon's POST /audit endpoint.
: "${AUDIT_LOG_DIR:=$HOME/.cache/synology-nas-mcp/audit}"
: "${MCP_AUDIT_URL:=http://nas.local:8765/audit}"
# Persist the DSM SID across tsx runs so we don't burn a TOTP code each process
# (DSM rejects TOTP reuse within the 30s window with code 404).
: "${DSM_SID_CACHE_FILE:=$HOME/.cache/synology-nas-mcp/sid.json}"
export DSM_OP_VAULT DSM_OP_ITEM DSM_BASE_URL DSM_USER \
       AUDIT_LOG_DIR MCP_AUDIT_URL DSM_SID_CACHE_FILE
# Cache dir holds the SID + audit log — keep it owner-only.
mkdir -p "$AUDIT_LOG_DIR" "$(dirname "$DSM_SID_CACHE_FILE")" 2>/dev/null
chmod 700 "$AUDIT_LOG_DIR" "$(dirname "$DSM_SID_CACHE_FILE")" 2>/dev/null

# Read-only service-account token (captured above) makes `op read` prompt-free;
# injected into op only — never re-exported — so children don't inherit vault
# access. Absent → op falls back to the interactive desktop-app integration.
_op() {
  if [ -n "$_optok" ]; then OP_SERVICE_ACCOUNT_TOKEN="$_optok" op read "$1"
  else op read "$1"; fi
}

_base="op://${DSM_OP_VAULT}/${DSM_OP_ITEM}"
DSM_PASSWORD=$(_op "${_base}/password")             || { echo "op read password failed" >&2; _optok=""; return 1; }
DSM_TOTP_SECRET=$(_op "${_base}/totp")              || { echo "op read totp failed" >&2; _optok=""; return 1; }
MCP_BEARER_TOKEN=$(_op "${_base}/mcp_bearer_token") || { echo "op read mcp_bearer_token failed" >&2; _optok=""; return 1; }
export DSM_PASSWORD DSM_TOTP_SECRET MCP_BEARER_TOKEN
echo "[dev] DSM creds loaded from 1Password"

unset _self_dir _optok _base
unset -f _op
