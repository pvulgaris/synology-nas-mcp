/**
 * Credential provider: reads DSM password, TOTP secret, and the wire bearer token
 * from a 1Password item via the `op` CLI. Generates fresh TOTP codes on demand.
 *
 * The `op` CLI authenticates via OP_SERVICE_ACCOUNT_TOKEN env var (set on the container
 * project in DSM Container Manager). No interactive auth, no biometric prompts.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authenticator } from "otplib";
import type { Config } from "./config.js";

const execFileP = promisify(execFile);

/** The login secrets a SynoClient actually needs (NAS or router). */
export interface DsmOnlyCredentials {
  password: string;
  totpSecret: string;
}

/** The MCP's own full credential set: DSM login secrets + the wire bearer. */
export interface Credentials extends DsmOnlyCredentials {
  bearerToken: string;
}

async function opRead(ref: string): Promise<string> {
  try {
    const { stdout } = await execFileP("op", ["read", ref], {
      env: process.env,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch (err: any) {
    const detail = err?.stderr ?? err?.message ?? String(err);
    throw new Error(`op read ${ref} failed: ${detail}`);
  }
}

const MIN_BEARER_LEN = 32;

/** Fail closed on missing login secrets — a blank/renamed 1Password field should
 *  refuse to start, not boot degraded. Applies to both NAS and router creds. */
function assertDsmCreds(c: DsmOnlyCredentials, label: string): void {
  if (!c.password) {
    throw new Error(`${label} password is empty — check the 1Password item or *_PASSWORD env.`);
  }
  if (!c.totpSecret) {
    throw new Error(`${label} TOTP secret is empty — check the 1Password item or *_TOTP_SECRET env.`);
  }
}

/** A blank/renamed bearer field would otherwise degrade wire auth to the 7-char
 *  constant "Bearer " — guessable by anyone who can reach the port. */
function assertBearer(bearerToken: string): void {
  if (!bearerToken || bearerToken.length < MIN_BEARER_LEN) {
    throw new Error(
      `MCP bearer token missing or too short (${bearerToken?.length ?? 0} chars; need >= ${MIN_BEARER_LEN}). ` +
        `A blank/renamed 1Password field degrades wire auth to a guessable constant. Regenerate with: openssl rand -hex 32`
    );
  }
}

export async function loadCredentials(cfg: Config): Promise<Credentials> {
  // DSM login secrets (password + totp) share the env fast-path, op-read, and
  // fail-closed logic with every other target — reuse loadDsmOnlyCredentials and
  // add only the wire bearer, the one field a NAS client has that a router client
  // doesn't. The bearer read runs concurrently with the delegate's pw/totp reads,
  // so this stays a single round of parallel `op read`s (and a pure-env dev config
  // makes zero op calls — see dev/source-creds.sh).
  const envBearer = process.env.MCP_BEARER_TOKEN;
  const [dsmCreds, bearerToken] = await Promise.all([
    loadDsmOnlyCredentials(cfg.opVault, cfg.opItem, "DSM"),
    envBearer ?? opRead(`op://${cfg.opVault}/${cfg.opItem}/mcp_bearer_token`),
  ]);
  assertBearer(bearerToken);
  return { ...dsmCreds, bearerToken };
}

/** Load just the DSM login secrets (password + totp) for a target — used by the
 *  router client, which has no bearer of its own. Env fast-path keys off
 *  `<envPrefix>_PASSWORD` / `<envPrefix>_TOTP_SECRET` (e.g. SRM_*), else
 *  `op read op://<vault>/<item>/{password,totp}`. Fails closed on blank secrets. */
export async function loadDsmOnlyCredentials(
  opVault: string,
  opItem: string,
  envPrefix = "DSM"
): Promise<DsmOnlyCredentials> {
  const envPw = process.env[`${envPrefix}_PASSWORD`];
  const envTotp = process.env[`${envPrefix}_TOTP_SECRET`];
  let creds: DsmOnlyCredentials;
  if (envPw && envTotp) {
    creds = { password: envPw, totpSecret: envTotp };
  } else {
    const base = `op://${opVault}/${opItem}`;
    const [password, totpSecret] = await Promise.all([
      envPw ?? opRead(`${base}/password`),
      envTotp ?? opRead(`${base}/totp`),
    ]);
    creds = { password, totpSecret };
  }
  // Label the fail-closed error with the prefix itself ("DSM" / "SRM") — both are
  // the product name now, so no need to special-case the non-DSM target.
  assertDsmCreds(creds, envPrefix);
  return creds;
}

export function currentTotpCode(secret: string): string {
  return authenticator.generate(secret);
}
