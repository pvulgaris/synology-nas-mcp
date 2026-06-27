/**
 * Thin DSM Web API client. Handles login (with TOTP), SID caching, and
 * automatic re-auth on 119 ("SID not found").
 *
 * Reference: Synology DSM Login Web API Guide; SYNO.API.* family endpoints.
 * We hit `entry.cgi` for almost everything (the unified DSM dispatcher).
 *
 * TLS: DSM ships with a self-signed cert by default. If `cfg.tlsSkipVerify`
 * is true, the cli sets NODE_TLS_REJECT_UNAUTHORIZED=0 process-wide at startup.
 * We do not paper over that here.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.js";
import { routerConfigFrom } from "./config.js";
import {
  currentTotpCode,
  loadCredentials,
  loadDsmOnlyCredentials,
  type DsmOnlyCredentials,
} from "./auth.js";

const SID_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Bound every HTTP call. A target reachable at the TCP layer but unresponsive at
// the application layer (a wedged SRM web service, a stalled TLS handshake) would
// otherwise hang on undici's multi-minute default — and because the digest awaits
// all sources, one such router would withhold the whole result past the MCP
// client's ~300s drop, defeating the "one device down never aborts the rest"
// guarantee. Reads return in seconds, so 30s is generous; on timeout fetch rejects
// (AbortError, not a DsmError) and the caller's catch / runSource surfaces it.
const REQUEST_TIMEOUT_MS = 30_000;

// Dev-only: persist the SID across `tsx` invocations so the harness doesn't
// burn a TOTP code on every run. DSM rejects reuse within the same 30s window
// with code 404 on login. In production the daemon stays up so this is a
// no-op; the env var is set only by dev/source-creds.sh.
function readSidCache(path: string): { sid: string; at: number } | null {
  try {
    const raw = readFileSync(path, "utf8");
    const j = JSON.parse(raw);
    if (typeof j?.sid === "string" && typeof j?.at === "number") return j;
  } catch {
    // missing or unparsable → treat as cache miss
  }
  return null;
}

function writeSidCache(path: string, sid: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sid, at: Date.now() }), { mode: 0o600 });
  } catch {
    // best-effort; dev convenience only
  }
}

export interface DsmResponse<T = any> {
  success: boolean;
  data?: T;
  error?: { code: number; errors?: any[] };
}

export interface DsmCallOptions {
  api: string;
  method: string;
  /** API version. Default: 1. */
  version?: number;
  params?: Record<string, string | number | boolean | undefined>;
  /** Use POST instead of GET (some mutating methods require it). */
  post?: boolean;
}

/** Methods a read-only client (the router) is allowed to call. Anything else —
 *  or any POST — is refused before it leaves the process. */
const READ_METHODS = new Set([
  "get",
  "list",
  "check",
  "info",
  "load_info",
  "query",
  "query_info",
  "status",
]);

/** DSM error codes we react to programmatically. The DSM Web API is
 *  reverse-engineered, so this is a small curated subset — see
 *  docs/dsm-api-quirks.md for the broader catalog. Only codes referenced in
 *  code belong here; document-only codes live in the quirks doc. */
export const DSM_ERR = {
  /** Session ID missing on a request that requires auth. Re-login + retry. */
  SID_NOT_FOUND: 117,
  /** Session ID expired or invalidated server-side. Re-login + retry. */
  SID_EXPIRED: 119,
} as const;

export class DsmError extends Error {
  constructor(
    public readonly api: string,
    public readonly method: string,
    public readonly code: number,
    public readonly errors: any[] | undefined,
    message: string
  ) {
    super(message);
    this.name = "DsmError";
  }
}

export interface DsmClientOptions {
  /** Refuse any mutating call (POST or non-read method). Used by the router
   *  client, which authenticates as a dedicated SRM admin — read-only is
   *  enforced here so a stray write can't leave the process. */
  readOnly?: boolean;
  /** Override how login secrets are fetched. The router passes the bearer-free
   *  loader; default is the MCP's own `loadCredentials`. */
  credLoader?: (cfg: Config) => Promise<DsmOnlyCredentials>;
}

export class DsmClient {
  private creds: DsmOnlyCredentials | null = null;
  private sid: string | null = null;
  private sidObtainedAt = 0;
  private readonly readOnly: boolean;
  private readonly credLoader: (cfg: Config) => Promise<DsmOnlyCredentials>;
  // Concurrent ensureSession() calls share the in-flight login. Without this,
  // a Promise.all of MCP tool calls fires N parallel logins that all reuse the
  // same 30s TOTP code; DSM accepts the first and 404s the rest.
  private loginInFlight: Promise<void> | null = null;

  constructor(private cfg: Config, opts: DsmClientOptions = {}) {
    this.readOnly = opts.readOnly ?? false;
    this.credLoader = opts.credLoader ?? loadCredentials;
    const cachePath = this.cfg.sidCacheFile;
    if (cachePath) {
      const cached = readSidCache(cachePath);
      if (cached && Date.now() - cached.at < SID_TTL_MS) {
        this.sid = cached.sid;
        this.sidObtainedAt = cached.at;
      }
    }
  }

  private async ensureSession(): Promise<void> {
    // Creds are loaded inside login() (under the loginInFlight guard), not here:
    // a fresh cached SID needs no creds, and loading here let the digest's
    // concurrent fan-out fire N redundant credLoader calls (an `op` subprocess
    // storm) on a cold client before any of them assigned this.creds.
    const fresh = this.sid && Date.now() - this.sidObtainedAt < SID_TTL_MS;
    if (fresh) return;
    if (!this.loginInFlight) {
      this.loginInFlight = this.login().finally(() => {
        this.loginInFlight = null;
      });
    }
    await this.loginInFlight;
  }

  private async login(): Promise<void> {
    if (!this.creds) this.creds = await this.credLoader(this.cfg);
    const otpCode = currentTotpCode(this.creds.totpSecret);
    const url = new URL(`${this.cfg.dsmBaseUrl}/webapi/${this.cfg.authPath}`);
    url.searchParams.set("api", "SYNO.API.Auth");
    url.searchParams.set("version", String(this.cfg.authVersion));
    url.searchParams.set("method", "login");
    url.searchParams.set("account", this.cfg.dsmUser);
    url.searchParams.set("passwd", this.creds.password);
    url.searchParams.set("otp_code", otpCode);
    url.searchParams.set("format", "sid");
    url.searchParams.set("session", this.cfg.session);
    // NOTE: do NOT request `enable_syno_token=yes` here. It makes DSM issue a
    // token-bound session that then rejects the plain `_sid` GET with code 119
    // on the very next call (verified against the live NAS). Every tool is a
    // read, so the CSRF token isn't needed; a future mutating path would fetch
    // it via a dedicated request rather than poisoning this read session.

    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json()) as DsmResponse<{ sid: string }>;
    if (!body.success || !body.data?.sid) {
      const code = body.error?.code ?? -1;
      // Surface the full auth error payload (matches callOnce's data-call logging);
      // login failures are otherwise opaque (just a code) and hard to diagnose.
      console.error(`[dsm] login ✗ code=${code}`, JSON.stringify(body.error ?? {}));
      throw new DsmError(
        "SYNO.API.Auth",
        "login",
        code,
        body.error?.errors,
        `DSM login failed (code ${code}). Confirm the DSM user exists, has 2FA on, and that the 1Password item fields match.`
      );
    }
    this.sid = body.data.sid;
    this.sidObtainedAt = Date.now();
    const cachePath = this.cfg.sidCacheFile;
    if (cachePath) writeSidCache(cachePath, this.sid);
  }

  /**
   * Call any DSM API method. Auto-handles SID expiry by re-logging in once on
   * codes 117 or 119 and retrying.
   */
  async call<T = any>(opts: DsmCallOptions): Promise<T> {
    if (this.readOnly && (opts.post || !READ_METHODS.has(opts.method))) {
      throw new Error(
        `Read-only DsmClient refused ${opts.api}.${opts.method}` +
          `${opts.post ? " (POST)" : ""} — this client is restricted to read methods.`
      );
    }
    await this.ensureSession();
    const sidAtCall = this.sid;
    try {
      return await this.callOnce<T>(opts);
    } catch (err) {
      if (
        err instanceof DsmError &&
        (err.code === DSM_ERR.SID_EXPIRED || err.code === DSM_ERR.SID_NOT_FOUND)
      ) {
        // Only invalidate if a concurrent caller hasn't already refreshed the SID.
        // Under the digest's parallel fan-out, a straggler that 119s *after* the
        // shared re-login completed would otherwise null the fresh SID and force a
        // second login within the 30s TOTP window (→ code 404). If it already
        // changed, skip the reset and just retry with the new SID.
        if (this.sid === sidAtCall) this.sid = null;
        await this.ensureSession();
        return await this.callOnce<T>(opts);
      }
      throw err;
    }
  }

  private async callOnce<T>(opts: DsmCallOptions): Promise<T> {
    const url = new URL(`${this.cfg.dsmBaseUrl}/webapi/entry.cgi`);
    const body = new URLSearchParams();
    const add = (k: string, v: string | number | boolean | undefined) => {
      if (v === undefined) return;
      const target = opts.post ? body : url.searchParams;
      target.append(k, String(v));
    };
    add("api", opts.api);
    add("version", opts.version ?? 1);
    add("method", opts.method);
    if (this.sid) add("_sid", this.sid);
    for (const [k, v] of Object.entries(opts.params ?? {})) add(k, v);

    // Log every call so Container Manager's log tab has the full DSM trace.
    // Trim _sid + passwd so the log isn't a secret. Other params are fine —
    // they're the actual call shape, useful for debugging mismatches.
    const safeParams: Record<string, string> = {};
    const src = opts.post ? body : url.searchParams;
    src.forEach((v, k) => {
      if (k === "_sid" || k === "passwd" || k === "otp_code") return;
      safeParams[k] = v;
    });
    const verb = opts.post ? "POST" : "GET";
    console.error(`[dsm] → ${verb} ${opts.api}.${opts.method}`, safeParams);

    const headers: Record<string, string> = {};
    if (opts.post) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const init: RequestInit = opts.post
      ? { method: "POST", headers, body: body.toString(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
      : { method: "GET", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    const res = await fetch(url, init);
    const json = (await res.json()) as DsmResponse<T>;
    if (!json.success) {
      const code = json.error?.code ?? -1;
      const errs = json.error?.errors;
      // Log the whole raw error payload — most DSM failure modes only make
      // sense when you can see the full response, not just the code.
      console.error(
        `[dsm] ✗ ${opts.api}.${opts.method} code=${code}`,
        JSON.stringify(json.error ?? {})
      );
      const detail = errs ? ` — ${JSON.stringify(errs)}` : "";
      throw new DsmError(
        opts.api,
        opts.method,
        code,
        errs,
        `${opts.api}.${opts.method} failed (code ${code})${detail}`
      );
    }
    if (process.env.DEBUG_DSM_RESPONSES === "1") {
      const blob = JSON.stringify(json.data ?? {});
      const trimmed = blob.length > 1500 ? blob.slice(0, 1500) + "…" : blob;
      console.error(`[dsm] ✓ ${opts.api}.${opts.method}`, trimmed);
    } else {
      console.error(`[dsm] ✓ ${opts.api}.${opts.method}`);
    }
    return (json.data ?? ({} as T));
  }

  hasSession(): boolean {
    return !!this.sid;
  }
}

/** Build the router (SRM) client from a Config, or null when no router target is
 *  configured. Always read-only and bearer-free — the single place that wiring
 *  lives, so the daemon and the CLI can't drift. */
export function makeRouterClient(cfg: Config): DsmClient | null {
  if (!cfg.router) return null;
  return new DsmClient(routerConfigFrom(cfg), {
    readOnly: true,
    credLoader: (c) => loadDsmOnlyCredentials(c.opVault, c.opItem, "ROUTER_DSM"),
  });
}
