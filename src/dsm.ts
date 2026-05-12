/**
 * Thin DSM Web API client. Handles login (with TOTP), SID caching, and
 * automatic re-auth on 119 ("SID not found").
 *
 * Reference: Synology DSM Login Web API Guide; SYNO.API.* family endpoints.
 * We hit `entry.cgi` for almost everything (the unified DSM dispatcher).
 *
 * TLS: DSM ships with a self-signed cert by default. If
 * `cfg.tlsRejectUnauthorized` is false, the cli sets NODE_TLS_REJECT_UNAUTHORIZED=0
 * process-wide at startup. We do not paper over that here.
 */

import type { Config } from "./config.js";
import { currentTotpCode, loadCredentials, type Credentials } from "./auth.js";

const SID_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface DsmResponse<T = any> {
  success: boolean;
  data?: T;
  error?: { code: number; errors?: any[] };
}

export interface DsmCallOptions {
  api: string;
  method: string;
  version?: number;
  params?: Record<string, string | number | boolean | undefined>;
  /** Use POST instead of GET (some mutating methods require it). */
  post?: boolean;
}

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

export class DsmClient {
  private creds: Credentials | null = null;
  private sid: string | null = null;
  private sidObtainedAt = 0;

  constructor(private cfg: Config) {}

  private async ensureSession(): Promise<void> {
    if (!this.creds) this.creds = await loadCredentials(this.cfg);
    const fresh = this.sid && Date.now() - this.sidObtainedAt < SID_TTL_MS;
    if (!fresh) await this.login();
  }

  private async login(): Promise<void> {
    if (!this.creds) this.creds = await loadCredentials(this.cfg);
    const otpCode = currentTotpCode(this.creds.totpSecret);
    const url = new URL(`${this.cfg.dsmBaseUrl}/webapi/entry.cgi`);
    url.searchParams.set("api", "SYNO.API.Auth");
    url.searchParams.set("version", "6");
    url.searchParams.set("method", "login");
    url.searchParams.set("account", this.cfg.dsmUser);
    url.searchParams.set("passwd", this.creds.password);
    url.searchParams.set("otp_code", otpCode);
    url.searchParams.set("format", "sid");
    url.searchParams.set("session", "synology-nas-mcp");

    const res = await fetch(url, { method: "GET" });
    const body = (await res.json()) as DsmResponse<{ sid: string }>;
    if (!body.success || !body.data?.sid) {
      const code = body.error?.code ?? -1;
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
  }

  /**
   * Call any DSM API method. Auto-handles SID expiry by re-logging in once on
   * codes 117 or 119 and retrying.
   */
  async call<T = any>(opts: DsmCallOptions): Promise<T> {
    await this.ensureSession();
    try {
      return await this.callOnce<T>(opts);
    } catch (err) {
      if (err instanceof DsmError && (err.code === 119 || err.code === 117)) {
        this.sid = null;
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

    const init: RequestInit = opts.post
      ? {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        }
      : { method: "GET" };
    const res = await fetch(url, init);
    const json = (await res.json()) as DsmResponse<T>;
    if (!json.success) {
      const code = json.error?.code ?? -1;
      const detail = json.error?.errors
        ? ` — ${JSON.stringify(json.error.errors)}`
        : "";
      throw new DsmError(
        opts.api,
        opts.method,
        code,
        json.error?.errors,
        `${opts.api}.${opts.method} failed (code ${code})${detail}`
      );
    }
    return (json.data ?? ({} as T));
  }

  hasSession(): boolean {
    return !!this.sid;
  }
}
