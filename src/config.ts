/**
 * Server config from env. All secrets are fetched separately via auth.ts (`op` CLI).
 *
 * Required:
 *   DSM_BASE_URL          e.g. https://localhost:5001 (in-container) or https://nas.local:5001 (laptop dev)
 *   DSM_OP_VAULT          1Password vault name holding the "Synology DSM - claude-mcp" item
 *   DSM_OP_ITEM           1Password item name (default: "Synology DSM - claude-mcp")
 *   DSM_USER              DSM account name (default: "claude-mcp")
 *
 * Optional:
 *   MCP_BIND_HOST         interface to bind HTTP transport (daemon mode); default: tailscale0 IP
 *   MCP_BIND_PORT         port for HTTP transport; default: 8765
 *   MCP_ALLOWED_ORIGINS   comma-separated Origin allowlist; default: localhost variants + null
 *   AUDIT_LOG_DIR         JSONL audit log directory; default: /volume1/docker/synology-nas-mcp/audit
 *   TLS_REJECT_UNAUTHORIZED  set "0" to skip cert validation for self-signed DSM certs (default: skip in dev)
 *
 * Optional — router (SRM) target, all back-compat (unset = NAS-only):
 *   ROUTER_BASE_URL       e.g. https://router.local:8001 (presence alone enables the router)
 *   ROUTER_USER           dedicated SRM admin account name (default: "claude-mcp", read-only usage)
 *   ROUTER_OP_ITEM        1Password item holding router password+totp (default: "Synology SRM - claude-mcp")
 */

/** Optional second target: the Synology router (SRM). SRM speaks the same
 *  SYNO.* Web API as DSM on port 8001. Its package/upgrade reads are admin-gated
 *  (no selective grant), so `user` must be an admin — use a *dedicated* SRM admin
 *  (claude-mcp-style; SRM supports extra admins via "Grant administrator
 *  privilege"), not the primary login. Read-only is enforced by the DsmClient
 *  read-only mode. null unless ROUTER_BASE_URL is set. */
export interface RouterTarget {
  baseUrl: string;
  user: string;
  opItem: string;
}

export interface Config {
  dsmBaseUrl: string;
  dsmUser: string;
  opVault: string;
  opItem: string;
  mcpBindHost: string | null;
  mcpBindPort: number;
  allowedOrigins: Set<string>;
  auditLogDir: string;
  /** When true, skip TLS cert verification — DSM ships with a self-signed cert
   *  out of the box, so this defaults true. Driven by the env var
   *  TLS_REJECT_UNAUTHORIZED ("0" → skip, anything else → enforce). */
  tlsSkipVerify: boolean;
  /** DSM login `session` label. Per-instance so a second (router) client logs in
   *  under a distinct session for clear server-side bookkeeping. */
  session: string;
  /** `SYNO.API.Auth` version used at login. DSM 7 uses v6; SRM's auth API caps at
   *  v3 (confirmed via SYNO.API.Info: auth.cgi min=1/max=3), so logging into the
   *  router with v6 fails with code 102. Per-instance so each target logs in at a
   *  version it supports. */
  authVersion: number;
  /** Web API path for the login call. DSM accepts `SYNO.API.Auth` at entry.cgi;
   *  SRM routes it only at auth.cgi (SYNO.API.Info reports path=auth.cgi and 102s
   *  on entry.cgi). Per-instance; data calls always go to entry.cgi. */
  authPath: string;
  /** Optional dev-only SID cache path. Per-instance so the router client can't
   *  stomp the NAS client's cached SID. Undefined → no cache (production). */
  sidCacheFile?: string;
  router: RouterTarget | null;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): Config {
  const dsmBaseUrl = required("DSM_BASE_URL").replace(/\/$/, "");
  const allowedOrigins = new Set(
    optional(
      "MCP_ALLOWED_ORIGINS",
      "http://localhost,http://127.0.0.1,null"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return {
    dsmBaseUrl,
    dsmUser: optional("DSM_USER", "claude-mcp"),
    opVault: required("DSM_OP_VAULT"),
    opItem: optional("DSM_OP_ITEM", "Synology DSM - claude-mcp"),
    mcpBindHost: process.env.MCP_BIND_HOST ?? null,
    mcpBindPort: parseInt(optional("MCP_BIND_PORT", "8765"), 10),
    allowedOrigins,
    auditLogDir: optional(
      "AUDIT_LOG_DIR",
      "/volume1/docker/synology-nas-mcp/audit"
    ),
    tlsSkipVerify: optional("TLS_REJECT_UNAUTHORIZED", "0") === "0",
    session: "synology-nas-mcp",
    authVersion: 6,
    authPath: "entry.cgi",
    sidCacheFile: process.env.DSM_SID_CACHE_FILE,
    router: parseRouter(),
  };
}

/** Read the optional router target. Presence of ROUTER_BASE_URL alone gates it;
 *  ROUTER_USER and ROUTER_OP_ITEM default to the dedicated-claude-mcp convention
 *  (see RouterTarget). ROUTER_USER must NOT be required() here: parseRouter runs
 *  inside loadConfig, so a missing required env would throw and take down the
 *  entire NAS daemon at boot — not just the optional router. */
function parseRouter(): RouterTarget | null {
  const baseUrl = process.env.ROUTER_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl) return null;
  return {
    baseUrl,
    // `|| ` not optional()'s `??`: Container Manager injects `ROUTER_USER:
    // ${ROUTER_USER:-}`, i.e. an empty string (not unset) when the host var is
    // absent — `??` would keep "" and log in with account="". Fall back (and
    // trim) so the dedicated-admin default actually applies in the Docker path.
    user: process.env.ROUTER_USER?.trim() || "claude-mcp",
    // Same empty-string hardening as ROUTER_USER: `${ROUTER_OP_ITEM:-}` in the
    // compose injects "" (not unset) when the host var is absent; optional()'s
    // `??` would keep it and build `op://vault//field`. Trim + fall back.
    opItem: process.env.ROUTER_OP_ITEM?.trim() || "Synology SRM - claude-mcp",
  };
}

/** Project the main Config onto the router target: same vault/origins/audit, but
 *  the router's base URL, admin user, 1Password item, a distinct session, and NO
 *  SID cache — the router always fresh-logs-in. (A dev disk SID cache was tried and
 *  reverted: SRM expires sessions faster than the client's 10-min TTL, so a cached
 *  SID goes stale → 119 → re-login → TOTP-reuse 404. Fresh login per process is
 *  reliable; the production daemon keeps its SID warm in-memory regardless. The
 *  back-to-back-within-30s dev case just waits a TOTP window.) */
export function routerConfigFrom(cfg: Config): Config {
  if (!cfg.router) {
    throw new Error("routerConfigFrom called without cfg.router");
  }
  return {
    ...cfg,
    dsmBaseUrl: cfg.router.baseUrl,
    dsmUser: cfg.router.user,
    opItem: cfg.router.opItem,
    session: `${cfg.session}-router`,
    authVersion: 3,
    authPath: "auth.cgi",
    sidCacheFile: undefined,
    // The projected config describes the router itself; clear `router` so a
    // stray makeRouterClient(routerConfigFrom(cfg)) can't build a router-of-the-router.
    router: null,
  };
}
