#!/usr/bin/env bash
# Source this (don't run it) once per dev shell. DSM creds live in the macOS
# Keychain (encrypted at rest with your login password) under service name
# "synology-nas-mcp". No TTL — entries persist until you explicitly refresh
# (after a 1Password rotation, etc.). The secrets never live on plain disk.
#
#   source dev/source-creds.sh
#
# Override the source vault/item with DSM_OP_VAULT / DSM_OP_ITEM before sourcing.
# To force a fresh op read after rotating creds in 1Password:
#   export REFRESH_CREDS=1; source dev/source-creds.sh
# The keychain entries are NOT cleared up front — only overwritten in place
# after a successful op fetch. A failed refresh (1Password locked, biometric
# timeout) leaves the existing entries usable as a fallback.
# To inspect a single entry:
#   security find-generic-password -s synology-nas-mcp -a DSM_PASSWORD -w
# To wipe the cache completely (forces a full re-fetch next source):
#   for a in DSM_PASSWORD DSM_TOTP_SECRET MCP_BEARER_TOKEN; do
#     security delete-generic-password -s synology-nas-mcp -a "$a"
#   done

: "${DSM_OP_VAULT:=Claude}"
: "${DSM_OP_ITEM:=Synology DSM}"
: "${DSM_BASE_URL:=https://nas.local:5001}"
: "${DSM_USER:=claude-mcp}"

export DSM_OP_VAULT DSM_OP_ITEM DSM_BASE_URL DSM_USER

# Local AUDIT_LOG_DIR fallback — only used if MCP_AUDIT_URL is unset. The
# canonical audit log lives on the NAS via the daemon's POST /audit endpoint;
# this fallback is for unconfigured dev shells (or daemon offline) so writes
# don't crash trying to mkdir /volume1.
: "${AUDIT_LOG_DIR:=$HOME/.cache/synology-nas-mcp/audit}"
export AUDIT_LOG_DIR

# Route every audit record written from dev tsx through the deployed daemon so
# the NAS-side log stays the single source of truth. The daemon validates the
# bearer (already in $MCP_BEARER_TOKEN from the keychain) and appends to
# /audit (bind-mounted to /volume1/docker/synology-nas-mcp/audit/).
: "${MCP_AUDIT_URL:=http://nas.local:8765/audit}"
export MCP_AUDIT_URL

# Persist DSM SID across npx tsx invocations so we don't burn a TOTP code on
# every run (DSM 7.3 rejects TOTP reuse within the 30s window with code 404).
: "${DSM_SID_CACHE_FILE:=$HOME/.cache/synology-nas-mcp/sid.json}"
export DSM_SID_CACHE_FILE

_cache_dir="${HOME}/.cache/synology-nas-mcp"
_kc_service="synology-nas-mcp"

mkdir -p "$_cache_dir" 2>/dev/null
chmod 700 "$_cache_dir" 2>/dev/null

_kc_get() {
  security find-generic-password -s "$_kc_service" -a "$1" -w 2>/dev/null
}

_kc_set() {
  # -U updates if the entry exists, adds if not. -T /usr/bin/security keeps
  # the ACL scoped to subsequent `security` CLI reads (no GUI app prompts).
  security add-generic-password -U \
    -s "$_kc_service" -a "$1" -w "$2" \
    -T /usr/bin/security >/dev/null
}

_kc_populated() {
  [ -n "$(_kc_get DSM_PASSWORD)" ] \
    && [ -n "$(_kc_get DSM_TOTP_SECRET)" ] \
    && [ -n "$(_kc_get MCP_BEARER_TOKEN)" ]
}

# One-shot migration from the legacy plain-file cache. If the old file
# exists, source it once, push values into the keychain, then delete it.
# Idempotent — subsequent sources just skip this block.
_legacy="${_cache_dir}/creds"
if [ -f "$_legacy" ]; then
  # shellcheck disable=SC1090
  . "$_legacy"
  if [ -n "${DSM_PASSWORD:-}" ] && [ -n "${DSM_TOTP_SECRET:-}" ] && [ -n "${MCP_BEARER_TOKEN:-}" ]; then
    _kc_set DSM_PASSWORD     "$DSM_PASSWORD"
    _kc_set DSM_TOTP_SECRET  "$DSM_TOTP_SECRET"
    _kc_set MCP_BEARER_TOKEN "$MCP_BEARER_TOKEN"
    rm -f "$_legacy"
    echo "[dev] migrated DSM creds: ${_legacy} → macOS Keychain (service=$_kc_service), file removed"
  fi
fi
# Also clean up the obsolete freshness-marker file from the brief TTL era.
rm -f "${_cache_dir}/keychain-cached-at" 2>/dev/null
unset _legacy

if [ "${REFRESH_CREDS:-}" != "1" ] && _kc_populated; then
  DSM_PASSWORD=$(_kc_get DSM_PASSWORD)
  DSM_TOTP_SECRET=$(_kc_get DSM_TOTP_SECRET)
  MCP_BEARER_TOKEN=$(_kc_get MCP_BEARER_TOKEN)
  export DSM_PASSWORD DSM_TOTP_SECRET MCP_BEARER_TOKEN
  echo "[dev] DSM creds loaded from macOS Keychain (service=$_kc_service)"
else
  base="op://${DSM_OP_VAULT}/${DSM_OP_ITEM}"
  _dsm_pw=$(op read "${base}/password") || { echo "op read password failed"; return 1; }
  _dsm_totp=$(op read "${base}/totp") || { echo "op read totp failed"; return 1; }
  _dsm_bearer=$(op read "${base}/mcp_bearer_token") || { echo "op read mcp_bearer_token failed"; return 1; }
  _kc_set DSM_PASSWORD     "$_dsm_pw"
  _kc_set DSM_TOTP_SECRET  "$_dsm_totp"
  _kc_set MCP_BEARER_TOKEN "$_dsm_bearer"
  export DSM_PASSWORD="$_dsm_pw"
  export DSM_TOTP_SECRET="$_dsm_totp"
  export MCP_BEARER_TOKEN="$_dsm_bearer"
  unset _dsm_pw _dsm_totp _dsm_bearer
  echo "[dev] DSM creds refreshed from 1Password → macOS Keychain"
fi

unset _cache_dir _kc_service
unset -f _kc_get _kc_set _kc_populated
