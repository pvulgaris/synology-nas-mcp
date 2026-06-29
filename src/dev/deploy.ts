/**
 * Auto-deploy a built image tar to the running Container Manager project.
 *
 * From the laptop: `npm run deploy` (or `npx tsx src/dev/runner.ts deploy`).
 * Walks: import the tar directly into DSM's Docker daemon → stop+build+start
 * the Compose project → poll /health until it reports the new version.
 *
 * The image upload uses DSM's chunked-upload URL pattern that the Container
 * Manager web UI uses:
 *   POST /webapi/entry.cgi/SYNO.Docker.Image?api=SYNO.Docker.Image&method=upload&version=1
 *   multipart/form-data; field name="filename" carries the tar body, with the
 *   multipart `filename` attribute set to the basename. X-SYNO-TOKEN header
 *   required.
 * This is NOT documented in the public DSM Web API docs — it was reverse-
 * engineered from a DevTools capture. Don't confuse it with `entry.cgi`'s
 * normal form-encoded API surface.
 *
 * Auth: standard claude-mcp login via dev/source-creds.sh. No FileStation
 * permission required — Image.upload's chunked-upload path bypasses the
 * shared-folder ACL entirely. Override the deploy identity with DSM_DEPLOY_*
 * env vars if you want a separate admin account.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { authenticator } from "otplib";
import type { Config } from "../config.js";
import { loadCredentials } from "../auth.js";

const execFileP = promisify(execFile);

const PROJECT_NAME_DEFAULT = "synology-nas-mcp";
const HEALTH_PORT_DEFAULT = 8765;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;

interface DeployArgs {
  tar: string;
  project?: string;
  healthPort?: number;
}

interface DeployResult {
  imageImported: boolean;
  projectId: string;
  healthVersion: string;
}

function log(...args: unknown[]) {
  console.error("[deploy]", ...args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Mint a fresh SID via TOTP. We don't reuse the cached SID for deploys
 *  because deploys can run as a different user (DSM_DEPLOY_USER) than the
 *  runtime claude-mcp. A fresh login keeps user separation explicit. */
async function loginForDeploy(
  cfg: Config
): Promise<{ sid: string; synotoken: string; user: string }> {
  const user = process.env.DSM_DEPLOY_USER ?? cfg.dsmUser;
  const password =
    process.env.DSM_DEPLOY_PASSWORD ??
    process.env.DSM_PASSWORD ??
    (await loadCredentials(cfg)).password;
  const totpSecret =
    process.env.DSM_DEPLOY_TOTP_SECRET ??
    process.env.DSM_TOTP_SECRET ??
    (await loadCredentials(cfg)).totpSecret;
  const totp = authenticator.generate(totpSecret);
  const url = new URL(`${cfg.dsmBaseUrl}/webapi/entry.cgi`);
  url.searchParams.set("api", "SYNO.API.Auth");
  url.searchParams.set("version", "6");
  url.searchParams.set("method", "login");
  url.searchParams.set("account", user);
  url.searchParams.set("passwd", password);
  url.searchParams.set("otp_code", totp);
  url.searchParams.set("format", "sid");
  url.searchParams.set("session", "synology-nas-mcp-deploy");
  url.searchParams.set("enable_syno_token", "yes");
  const res = await fetch(url, { method: "GET" });
  const body = (await res.json()) as any;
  if (!body?.success) {
    const code = body?.error?.code ?? -1;
    throw new Error(
      `Deploy login failed (code ${code}). Set DSM_DEPLOY_USER/PASSWORD/TOTP_SECRET to use a different admin account.`
    );
  }
  return {
    sid: body.data.sid,
    synotoken: body.data.synotoken ?? "",
    user,
  };
}

/** Build curl args common to every deploy call: silent + optional TLS skip.
 *  `-k` is gated on `cfg.tlsSkipVerify` so dev shells trusting DSM's
 *  self-signed cert (the default) still work, while a future caller that
 *  imports a real cert into the system trust store gets verification. */
function curlBase(cfg: Config): string[] {
  const args = ["-s"];
  if (cfg.tlsSkipVerify) args.push("-k");
  return args;
}

/** Upload + import the image tar in one shot via the chunked-upload URL the
 *  DSM Container Manager UI uses. Streams via curl — Node fetch chokes on
 *  multipart bodies past ~16MB (silently produces a body its undici impl
 *  can't stream cleanly), while curl handles it. */
async function uploadImage(
  cfg: Config,
  auth: { sid: string; synotoken: string; user: string },
  tarPath: string
): Promise<void> {
  const st = await stat(tarPath);
  const filename = basename(tarPath);
  // The Container Manager UI uses an undocumented chunked-upload URL pattern:
  // the API name appears as a path segment after entry.cgi. The form field
  // carrying the file body is also named `filename` (DSM reuses that string
  // for both the form-data `name` and the multipart `filename` attribute).
  const url = `${cfg.dsmBaseUrl}/webapi/entry.cgi/SYNO.Docker.Image?api=SYNO.Docker.Image&method=upload&version=1`;
  log(`uploading + importing ${filename} (${(st.size / 1024 / 1024).toFixed(1)} MB)…`);
  const args = [
    ...curlBase(cfg),
    "-X",
    "POST",
    url,
    "-H",
    `X-SYNO-TOKEN: ${auth.synotoken}`,
    "-H",
    `Cookie: id=${auth.sid}`,
    "-F",
    `filename=@${tarPath};filename=${filename}`,
  ];
  const { stdout } = await execFileP("curl", args, { maxBuffer: 4 * 1024 * 1024 });
  let body: any;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Error(`Image.upload returned non-JSON: ${stdout.slice(0, 200)}`);
  }
  if (!body?.success) {
    throw new Error(`Image.upload failed (code ${body?.error?.code}): ${stdout.slice(0, 400)}`);
  }
  log(`image imported`);
}

/** Run a DSM Web API call with SynoToken via curl. DSM gates mutating
 *  endpoints (Image.upload, Project.{stop,start,build}) on the CSRF token
 *  even when the SID is valid; without it you get a misleading code 119
 *  "SID not found". curl is also easier than coercing a fresh SynoClient to
 *  thread the token through. */
async function dsmCallWithToken<T = any>(
  cfg: Config,
  auth: { sid: string; synotoken: string },
  opts: { api: string; method: string; version: number; params?: Record<string, string> }
): Promise<T> {
  const url = new URL(`${cfg.dsmBaseUrl}/webapi/entry.cgi`);
  url.searchParams.set("_sid", auth.sid);
  if (auth.synotoken) url.searchParams.set("SynoToken", auth.synotoken);
  const args: string[] = [...curlBase(cfg), "-X", "POST", url.toString()];
  const dataPairs: Record<string, string> = {
    api: opts.api,
    version: String(opts.version),
    method: opts.method,
    ...(opts.params ?? {}),
  };
  for (const [k, v] of Object.entries(dataPairs)) {
    args.push("--data-urlencode", `${k}=${v}`);
  }
  if (auth.synotoken) args.push("-H", `X-SYNO-TOKEN: ${auth.synotoken}`);
  console.error(`[dsm-curl] → ${opts.api}.${opts.method}`, opts.params ?? {});
  const { stdout } = await execFileP("curl", args, { maxBuffer: 16 * 1024 * 1024 });
  let body: any;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Error(`${opts.api}.${opts.method} returned non-JSON: ${stdout.slice(0, 200)}`);
  }
  if (!body?.success) {
    throw new Error(
      `${opts.api}.${opts.method} failed (code ${body?.error?.code}): ${JSON.stringify(body.error)}`
    );
  }
  console.error(`[dsm-curl] ✓ ${opts.api}.${opts.method}`);
  return body.data as T;
}

/** Look up the Compose project by name. Returns id + current status so the
 *  caller knows whether `start` is needed after `build`. */
async function findProject(
  cfg: Config,
  auth: { sid: string; synotoken: string },
  projectName: string
): Promise<{ id: string; status: string }> {
  const list = await dsmCallWithToken<any>(cfg, auth, {
    api: "SYNO.Docker.Project",
    method: "list",
    version: 1,
  });
  if (!list || typeof list !== "object") {
    throw new Error(`Project.list returned unexpected shape: ${JSON.stringify(list)}`);
  }
  const entries: Array<{ id: string; name: string; status: string }> = Object.values(
    list
  ).map((v: any) => ({ id: v.id, name: v.name, status: v.status }));
  const match = entries.find((e) => e.name === projectName);
  if (!match) {
    const names = entries.map((e) => e.name).join(", ") || "<none>";
    throw new Error(`Compose project '${projectName}' not found. Existing: ${names}`);
  }
  log(`project ${projectName} → uuid=${match.id} status=${match.status}`);
  return { id: match.id, status: match.status };
}

/** Recycle the Compose project to pick up the new :latest image. `Project.build`
 *  by itself recreates containers (which atomically stops + replaces + starts
 *  if the project was running), so we skip the explicit stop call — each stop
 *  spawns a "Critical: Container stopped unexpectedly" notification in DSM,
 *  and one per deploy adds up fast during iteration.
 *
 *  If the project was already STOPPED before we got here (rare, but happens
 *  after a previous deploy that failed mid-flight), build alone won't start
 *  it, so we follow up with start. From RUNNING this is a no-op. */
async function rebuildProject(
  cfg: Config,
  auth: { sid: string; synotoken: string },
  projectId: string,
  initialStatus: string
): Promise<void> {
  log(`building project (recreates containers with new :latest)…`);
  await dsmCallWithToken(cfg, auth, {
    api: "SYNO.Docker.Project",
    method: "build",
    version: 1,
    params: { id: projectId },
  });
  if (initialStatus !== "RUNNING") {
    log(`project was ${initialStatus}; explicit start to bring it up…`);
    await dsmCallWithToken(cfg, auth, {
      api: "SYNO.Docker.Project",
      method: "start",
      version: 1,
      params: { id: projectId },
    });
  }
}

/** Poll the daemon's /health until it reports the version we just shipped. */
async function pollHealth(
  cfg: Config,
  expectedVersion: string,
  port: number
): Promise<string> {
  // Default: hit /health directly on the daemon port (same host as DSM).
  // When the daemon binds loopback-only (fronted by `tailscale serve`), that
  // port isn't reachable from here, so MCP_HEALTH_URL overrides with the serve
  // endpoint. Bearer not required for /health.
  const url =
    process.env.MCP_HEALTH_URL ??
    `http://${new URL(cfg.dsmBaseUrl).hostname}:${port}/health`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastErr: string | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as any;
        if (body?.version === expectedVersion) {
          log(`✓ ${url} reports version ${body.version}`);
          return body.version;
        }
        lastErr = `version=${body?.version}, expected=${expectedVersion}`;
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`/health never reported ${expectedVersion} within ${POLL_TIMEOUT_MS / 1000}s; last=${lastErr}`);
}

export async function deploy(cfg: Config, args: DeployArgs): Promise<DeployResult> {
  const tarPath = args.tar;
  const projectName = args.project ?? PROJECT_NAME_DEFAULT;
  const healthPort = args.healthPort ?? HEALTH_PORT_DEFAULT;

  const st = await stat(tarPath).catch(() => null);
  if (!st || !st.isFile()) {
    throw new Error(`tar not found at ${tarPath}`);
  }
  log(`tar: ${tarPath} (${(st.size / 1024 / 1024).toFixed(1)} MB)`);

  // Read the version we expect from package.json so the /health check is
  // tied to the build under deploy, not the file name.
  const pkg = JSON.parse(
    await readFile(
      join(new URL(import.meta.url).pathname, "..", "..", "..", "package.json"),
      "utf8"
    )
  );
  const expectedVersion = pkg.version as string;
  log(`target version: ${expectedVersion}`);

  // Login as the deploy user (defaults to claude-mcp; overridable via env).
  // We carry SID + SynoToken explicitly through the rest of the flow — every
  // mutating Docker.* endpoint requires the CSRF token, and threading it via
  // SynoClient would mean a bigger change for a one-shot path.
  const auth = await loginForDeploy(cfg);
  log(`logged in as ${auth.user}`);

  // 1. Upload + import (one call via the chunked-upload URL)
  await uploadImage(cfg, auth, tarPath);

  // 2. Restart project
  const { id: projectId, status } = await findProject(cfg, auth, projectName);
  await rebuildProject(cfg, auth, projectId, status);

  // 3. Verify
  const healthVersion = await pollHealth(cfg, expectedVersion, healthPort);

  return {
    imageImported: true,
    projectId,
    healthVersion,
  };
}
