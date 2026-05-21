/**
 * Package Center tools — reads + write tools (install, uninstall, update).
 *
 * == Upgrade flow (re-verified from a fresh HAR on 2026-05-20) ==
 *
 * The first `Installation.upgrade` call ONLY downloads the .spk. A second
 * `Installation.upgrade` with `path` + `installrunpackage:true` is what
 * actually applies the install. v0.2.11–v0.2.25 omitted that second call
 * and silently failed on packages that don't auto-install post-download
 * (HybridShare, FileStation — observed as 15-min "version never flipped"
 * timeouts with the .spk left orphaned in /volume1/@tmp/synopkg/).
 *
 *   1. SYNO.Core.Package.feasibility_check          preflight
 *   2. SYNO.Core.Package.Installation.get_queue     plan + dep check
 *   3. SYNO.Core.Package.Installation.check v=2     preflight w/ ver+size+blupgrade
 *   4. SYNO.Core.Package.Installation.upgrade v=1   DOWNLOAD (url/checksum/filesize)
 *                                                   → returns taskid @SYNOPKG_DOWNLOAD_<id>
 *   5. Poll Installation.status until finished:true → .spk on disk
 *   6. SYNO.Core.Package.Installation.Download.check → filename = downloaded .spk path
 *   7. SYNO.Core.Package.Installation.check v=2     simpler shape (id + install_type only)
 *   8. SYNO.Core.Package.Installation.upgrade v=1   INSTALL FROM PATH
 *                                                   (path, extra_values:"{}",
 *                                                   installrunpackage:true,
 *                                                   force:true, check_codesign:true)
 *   9. Poll Package.list for the version flip       definitive completion signal
 *  10. SYNO.Core.Package.Installation.delete        cleanup the .spk
 *
 * Param values are JSON-encoded in the form body (DSM JSON-parses each one):
 * strings carry quotes (`name="FileStation"`), bools/numbers/null are literal,
 * arrays/objects are JSON-stringified. `extra_values:"{}"` is a string carrying
 * a JSON object literal — wire form has both layers of quoting.
 *
 * APIs used:
 *   SYNO.Core.Package                       v2  list installed; v1 feasibility_check
 *   SYNO.Core.Package.Server                v2  catalog (link/md5/size + flags)
 *   SYNO.Core.Package.Installation          v1  upgrade / status / delete
 *                                           v2  check (returns volume_path)
 *   SYNO.Core.Package.Installation.Download v1  check (returns staged .spk path)
 *   SYNO.Core.Package.Installation.get_queue (on Installation, v1)
 *   SYNO.Core.Package.Uninstallation        v1  uninstall
 */

import type { Config } from "../config.js";
import type { DsmClient } from "../dsm.js";
import { withAudit } from "../audit.js";

// DSM response shapes used by the install/uninstall/update flows. None are
// documented — observed from HAR captures and reverse-engineered. Fields are
// optional because DSM omits keys when they don't apply (e.g. Download.check
// has no `filename` until the download is staged).

interface TaskidResp {
  taskid?: string;
}

interface InstallCheckResp {
  volume_path?: string;
}

interface InstallStatusResp {
  success?: boolean;
  status?: string;
  progress?: number;
  finished?: boolean;
}

interface DownloadCheckResp {
  filename?: string;
}

interface QueueResp {
  broken_pkgs?: unknown[];
  conflicted_pkgs?: unknown[];
  non_exist_pkgs?: unknown[];
  paused_pkgs?: unknown[];
}

interface ApplyUpgradeResp {
  worker_message?: unknown[];
}

interface InstalledPackage {
  id: string;
  name: string;
  version: string;
  additional?: {
    description?: string;
    status?: string;
    beta?: boolean;
    install_type?: string;
    startable?: boolean;
  };
}

interface CatalogPackage {
  id: string;
  name: string;
  version: string;
  link?: string;
  md5?: string;
  size?: number | string;
  source?: string;
  beta?: boolean;
  install_type?: string;
  install_on_cold_storage?: boolean;
  publisher?: string;
  description?: string;
  changelog?: string;
  depend_packages?: unknown;
  install_dep_packages?: unknown;
}

interface PackageListResp {
  packages?: InstalledPackage[];
}

interface CatalogListResp {
  packages?: CatalogPackage[];
}

const HARD_REFUSE_NAMES = new Set(["DSM", "kernel"]);

const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000; // 15 min — big packages can be slow
const DOWNLOAD_POLL_MS = 2000;
const POSTOP_VERIFY_TIMEOUT_MS = 5 * 60 * 1000;
const POSTOP_POLL_MS = 3000;

function refuseIfProtected(name: string) {
  if (HARD_REFUSE_NAMES.has(name)) {
    throw new Error(
      `Refusing to operate on package "${name}" — DSM/kernel updates can brick the host and are out of scope for this MCP. Apply via DSM UI → Control Panel → Update & Restore.`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ──────────── Reads ────────────

// On DSM 7's Package.list, `status` and install-type info nest under
// `additional`, not top-level (see docs/dsm-api-quirks.md). `is_system` is
// derived from `additional.install_type === "system"` — those packages are
// DSM-bundled and can't be uninstalled via Package Center.
export async function nasPackagesList(dsm: DsmClient) {
  const data = await dsm.call<PackageListResp>({
    api: "SYNO.Core.Package",
    method: "list",
    version: 2,
    params: {
      additional: '["description","status","beta","install_type","startable"]',
    },
  });
  return {
    packages: (data?.packages ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      status: p.additional?.status,
      additional: {
        description: p.additional?.description,
        beta: p.additional?.beta,
        is_system: p.additional?.install_type === "system",
        install_type: p.additional?.install_type,
        startable: !!p.additional?.startable,
      },
    })),
  };
}

export async function nasPackagesCheckUpdates(dsm: DsmClient) {
  const [installed, catalog] = await Promise.all([
    dsm.call<PackageListResp>({
      api: "SYNO.Core.Package",
      method: "list",
      version: 2,
    }),
    dsm.call<CatalogListResp>({
      api: "SYNO.Core.Package.Server",
      method: "list",
      version: 2,
      params: { tab: "update" },
    }),
  ]);
  const installedVersionById = new Map<string, string>();
  for (const p of installed?.packages ?? []) {
    installedVersionById.set(p.id, p.version);
  }
  const pending: Array<Record<string, unknown>> = [];
  for (const p of catalog?.packages ?? []) {
    if (HARD_REFUSE_NAMES.has(p.id)) continue;
    const installedVersion = installedVersionById.get(p.id);
    if (!installedVersion) continue;
    if (installedVersion === p.version) continue;
    pending.push({
      id: p.id,
      name: p.name,
      installed_version: installedVersion,
      available_version: p.version,
      changelog: p.changelog,
      beta: p.beta,
    });
  }
  return { pending };
}

// DSM has no `SYNO.Core.Package.Server.get` method (returns code 103, "method
// not found"), so we list the full catalog and filter. Same pattern as
// `findInCatalog`; kept separate because the read tool surfaces different
// fields (publisher/changelog/deps) and shouldn't share that helper's throw
// shape.
export async function nasPackageInfo(
  dsm: DsmClient,
  args: { name: string }
) {
  const data = await dsm.call<CatalogListResp>({
    api: "SYNO.Core.Package.Server",
    method: "list",
    version: 2,
    params: { tab: "all" },
  });
  const pkg = (data?.packages ?? []).find(
    (p) => p.id === args.name || p.name === args.name
  );
  if (!pkg) {
    throw new Error(
      `Package "${args.name}" not found in the Synology repo catalog for this DS.`
    );
  }
  return {
    id: pkg.id,
    name: pkg.name,
    version: pkg.version,
    publisher: pkg.publisher,
    description: pkg.description,
    changelog: pkg.changelog,
    dependencies: pkg.depend_packages,
    install_dep_packages: pkg.install_dep_packages,
    size: pkg.size,
    beta: pkg.beta,
  };
}

// ──────────── Write helpers ────────────

interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  /** Download URL (`link` field in DSM response). */
  link: string;
  /** MD5 of the .spk file. */
  md5: string;
  /** File size in bytes (DSM returns string or number — keep as string). */
  size: string;
  /** "syno" for Synology-published, anything else for community feeds. */
  source: string;
  /** Beta flag — required by Installation.upgrade. */
  beta: boolean;
  /** "system" / "" / etc. — passed through to Installation.check. */
  installType: string;
  /** Cold-storage flag from the catalog — passed through to Installation.check. */
  installOnColdStorage: boolean;
}

/** Read the catalog entry for a package id (or display name). Returns the
 *  download metadata the multi-step install/upgrade flow needs. */
async function findInCatalog(
  dsm: DsmClient,
  packageId: string
): Promise<CatalogEntry> {
  const data = await dsm.call<CatalogListResp>({
    api: "SYNO.Core.Package.Server",
    method: "list",
    version: 2,
    params: { tab: "all" },
  });
  const pkg = (data?.packages ?? []).find(
    (p) => p.id === packageId || p.name === packageId
  );
  if (!pkg) {
    throw new Error(
      `Package "${packageId}" not found in the Synology repo catalog for this DS. For non-repo packages, install via Package Center → Manual Install with a .spk file.`
    );
  }
  if (!pkg.link || !pkg.md5 || pkg.size == null) {
    throw new Error(
      `Catalog entry for "${packageId}" is missing download fields (link/md5/size): ${JSON.stringify(pkg)}`
    );
  }
  return {
    id: pkg.id,
    name: pkg.name,
    version: pkg.version,
    link: pkg.link,
    md5: pkg.md5,
    size: String(pkg.size),
    source: pkg.source ?? "",
    beta: !!pkg.beta,
    installType: pkg.install_type ?? "",
    installOnColdStorage: !!pkg.install_on_cold_storage,
  };
}

async function listOneState(dsm: DsmClient, name: string) {
  const all = await nasPackagesList(dsm);
  return all.packages.find((p) => p.id === name || p.name === name) ?? null;
}

type PackageState = Awaited<ReturnType<typeof listOneState>>;

async function waitForState(
  dsm: DsmClient,
  packageId: string,
  predicate: (state: PackageState) => boolean
): Promise<PackageState> {
  const deadline = Date.now() + POSTOP_VERIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await listOneState(dsm, packageId);
    if (predicate(state)) return state;
    await sleep(POSTOP_POLL_MS);
  }
  return await listOneState(dsm, packageId);
}

// ──────────── Write tools ────────────

/** Preflight: ask DSM whether the package can be installed/upgraded. Returns
 *  {success:true} on the happy path; a 400-style code means hard refusal. */
async function feasibilityCheck(
  dsm: DsmClient,
  packageId: string
): Promise<void> {
  await dsm.call({
    api: "SYNO.Core.Package",
    method: "feasibility_check",
    version: 1,
    post: true,
    params: {
      type: JSON.stringify("install_check"),
      packages: JSON.stringify([packageId]),
    },
  });
}

/** Ask DSM to plan the install queue. Returns broken/conflicted/paused
 *  packages so we can refuse early if there's a known dep problem. */
async function getInstallQueue(
  dsm: DsmClient,
  packageId: string,
  version: string,
  beta: boolean
): Promise<void> {
  const res = await dsm.call<QueueResp>({
    api: "SYNO.Core.Package.Installation",
    method: "get_queue",
    version: 1,
    post: true,
    params: {
      pkgs: JSON.stringify([
        { pkg: packageId, operation: "install", version, beta },
      ]),
    },
  });
  for (const key of ["broken_pkgs", "conflicted_pkgs", "non_exist_pkgs", "paused_pkgs"] as const) {
    const arr = res?.[key];
    if (Array.isArray(arr) && arr.length > 0) {
      throw new Error(
        `Cannot upgrade ${packageId}: ${key.replace("_pkgs", "")} = ${JSON.stringify(arr)}`
      );
    }
  }
}

/** Installation.check v=2 — preflight that returns the volume_path DSM will
 *  install into. We pass the package metadata from the catalog so DSM can
 *  validate dep/size/etc. `blupgrade` differs for install vs upgrade flows. */
async function installationCheck(
  dsm: DsmClient,
  catalog: CatalogEntry,
  isUpgrade: boolean
): Promise<{ volumePath: string }> {
  const res = await dsm.call<InstallCheckResp>({
    api: "SYNO.Core.Package.Installation",
    method: "check",
    version: 2,
    post: true,
    params: {
      depsers: JSON.stringify(""),
      deppkgs: "null",
      conflictpkgs: "null",
      breakpkgs: "null",
      replacepkgs: "null",
      ver: JSON.stringify(catalog.version),
      size: catalog.size,
      id: JSON.stringify(catalog.id),
      blupgrade: isUpgrade,
      install_type: JSON.stringify(catalog.installType),
      install_on_cold_storage: catalog.installOnColdStorage,
      blCheckDep: false,
    },
  });
  return { volumePath: typeof res?.volume_path === "string" ? res.volume_path : "" };
}

/** Start the .spk download (upgrade) or fresh install. Both flows hit
 *  Installation.{upgrade,install} with near-identical params — only the
 *  method, the `operation` enum, and a trailing `volume_path` (install only)
 *  differ. Returns the sentinel taskid (`@SYNOPKG_DOWNLOAD_<id>` for upgrade).
 *
 *  The response's `progress:1` is misleading — it refers to the queue-accept,
 *  not the file transfer. Use Installation.status's `finished:true` to know
 *  the .spk is on disk.
 *
 *  The install path is NOT HAR-verified to the same level as upgrade (we only
 *  captured an upgrade), but the symmetric assumption is the same DSM Package
 *  Center JS code path; the prior multi-step "download then install with path"
 *  shape failed the same way our pre-v0.2.11 upgrade did. */
async function startInstallation(
  dsm: DsmClient,
  catalog: CatalogEntry,
  mode: "upgrade" | "install",
  volumePath?: string
): Promise<string> {
  const params: Record<string, string | number | boolean> = {
    name: JSON.stringify(catalog.id),
    is_syno: catalog.source === "syno",
    beta: catalog.beta,
    url: JSON.stringify(catalog.link),
    checksum: JSON.stringify(catalog.md5),
    filesize: catalog.size,
    type: 0,
    blqinst: false,
    operation: JSON.stringify(mode),
  };
  if (mode === "install" && volumePath) {
    params.volume_path = JSON.stringify(volumePath);
  }
  const res = await dsm.call<TaskidResp>({
    api: "SYNO.Core.Package.Installation",
    method: mode === "upgrade" ? "upgrade" : "install",
    version: 1,
    post: true,
    params,
  });
  if (typeof res?.taskid !== "string" || res.taskid.length === 0) {
    throw new Error(
      `Installation.${mode} did not return a taskid; got: ${JSON.stringify(res)}`
    );
  }
  return res.taskid;
}

/** Poll Installation.status until `finished:true`, then resolve the staged
 *  .spk path via Installation.Download.check. The path is what the second
 *  upgrade call needs to actually install. */
async function waitForDownloadAndGetPath(
  dsm: DsmClient,
  taskId: string
): Promise<string> {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const s = await dsm.call<InstallStatusResp>({
      api: "SYNO.Core.Package.Installation",
      method: "status",
      version: 1,
      post: true,
      params: { task_id: taskId },
    });
    if (s?.success === false) {
      throw new Error(`Download failed: ${JSON.stringify(s)}`);
    }
    const status = String(s?.status ?? "");
    if (status !== lastStatus) {
      console.error(
        `[packages] download ${taskId} status=${status} finished=${s?.finished}`
      );
      lastStatus = status;
    }
    if (s?.finished === true) {
      const dl = await dsm.call<DownloadCheckResp>({
        api: "SYNO.Core.Package.Installation.Download",
        method: "check",
        version: 1,
        post: true,
        params: { taskid: taskId },
      });
      if (typeof dl?.filename !== "string" || dl.filename.length === 0) {
        throw new Error(
          `Download finished but Download.check returned no filename: ${JSON.stringify(dl)}`
        );
      }
      return dl.filename;
    }
    await sleep(DOWNLOAD_POLL_MS);
  }
  throw new Error(
    `Download timeout after ${DOWNLOAD_TIMEOUT_MS / 1000}s; .spk never finished staging`
  );
}

/** Phase 2 of upgrade: lightweight preflight + the install-from-path call.
 *  The HAR has these batched in a SYNO.Entry.Request compound; sending them
 *  as separate sequential POSTs is equivalent (DSM doesn't gate the upgrade
 *  on the check having shared a request). */
async function applyDownloadedUpgrade(
  dsm: DsmClient,
  catalog: CatalogEntry,
  downloadedPath: string
): Promise<void> {
  await dsm.call({
    api: "SYNO.Core.Package.Installation",
    method: "check",
    version: 2,
    post: true,
    params: {
      id: JSON.stringify(catalog.id),
      install_type: JSON.stringify(catalog.installType),
      install_on_cold_storage: catalog.installOnColdStorage,
      breakpkgs: "null",
      blCheckDep: false,
      replacepkgs: "null",
    },
  });
  const res = await dsm.call<ApplyUpgradeResp>({
    api: "SYNO.Core.Package.Installation",
    method: "upgrade",
    version: 1,
    post: true,
    params: {
      path: JSON.stringify(downloadedPath),
      extra_values: JSON.stringify("{}"),
      type: 0,
      check_codesign: true,
      force: true,
      installrunpackage: true,
    },
  });
  if (Array.isArray(res?.worker_message) && res.worker_message.length > 0) {
    throw new Error(
      `Install-from-path returned worker_message: ${JSON.stringify(res.worker_message)}`
    );
  }
}

/** Poll Package.list until the version flips to the target. The status
 *  endpoint reports `status:"upgrading"` long after the swap has happened
 *  server-side, so Package.list is the authoritative signal. */
async function waitForVersionFlip(
  dsm: DsmClient,
  packageId: string,
  targetVersion: string
): Promise<PackageState> {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const live = await listOneState(dsm, packageId);
    if (live?.version === targetVersion) return live;
    await sleep(DOWNLOAD_POLL_MS);
  }
  throw new Error(
    `Install timeout after ${DOWNLOAD_TIMEOUT_MS / 1000}s; package still at old version`
  );
}

/** Install-flow completion poller. Same Package.list version-flip signal as
 *  upgrade, plus a per-tick Installation.status check whose only job is to
 *  catch `success === false` early — otherwise a doomed install would sit on
 *  the 15-min timeout instead of failing in seconds. The install method
 *  isn't HAR-verified at the same level as upgrade, so we keep this
 *  defense-in-depth signal here even though CLAUDE.md notes status is
 *  unreliable for *completion* detection. Package.list is sampled at a
 *  slower cadence than status — version-flip is rare during install but
 *  the response carries every installed package's `additional[]` payload. */
async function waitForInstall(
  dsm: DsmClient,
  taskId: string,
  packageId: string,
  targetVersion: string
): Promise<PackageState> {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  let nextListCheck = 0;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const s = await dsm.call<InstallStatusResp>({
      api: "SYNO.Core.Package.Installation",
      method: "status",
      version: 1,
      post: true,
      params: { task_id: taskId },
    });
    if (s?.success === false) {
      throw new Error(`Install failed mid-flight: ${JSON.stringify(s)}`);
    }
    const status = String(s?.status ?? "");
    if (status !== lastStatus) {
      console.error(`[packages] install ${taskId} status=${status}`);
      lastStatus = status;
    }
    if (Date.now() >= nextListCheck) {
      const live = await listOneState(dsm, packageId);
      if (live?.version === targetVersion) return live;
      nextListCheck = Date.now() + DOWNLOAD_POLL_MS * 3;
    }
    await sleep(DOWNLOAD_POLL_MS);
  }
  throw new Error(
    `Install timeout after ${DOWNLOAD_TIMEOUT_MS / 1000}s; package not yet showing in Package.list`
  );
}

/** Cleanup the .spk file DSM staged into /volume1/@tmp/synopkg/. The DSM UI
 *  does this last; best-effort here (we don't fail the whole upgrade if it
 *  4xx's). */
async function cleanupUpgradeTmp(
  dsm: DsmClient,
  downloadedPath: string
): Promise<void> {
  if (!downloadedPath) return;
  try {
    await dsm.call({
      api: "SYNO.Core.Package.Installation",
      method: "delete",
      version: 1,
      post: true,
      params: { path: JSON.stringify(downloadedPath) },
    });
  } catch {
    // best-effort
  }
}

export async function nasPackageUpdate(
  cfg: Config,
  dsm: DsmClient,
  args: { name: string }
) {
  refuseIfProtected(args.name);
  const [before, catalog] = await Promise.all([
    listOneState(dsm, args.name),
    findInCatalog(dsm, args.name),
  ]);
  if (!before) {
    throw new Error(
      `Package "${args.name}" is not installed. Use nas_package_install for fresh installs.`
    );
  }
  if (catalog.version === before.version) {
    throw new Error(
      `Package "${args.name}" is already at the latest version (${before.version}); no update available.`
    );
  }

  const { after, ok } = await withAudit(
    cfg,
    { tool: "nas_package_update", args: { ...args, target_version: catalog.version }, before },
    async (ctx) => {
      // Match the DSM UI's exact sequence (re-verified from HAR 2026-05-20).
      await feasibilityCheck(dsm, catalog.id);
      await getInstallQueue(dsm, catalog.id, catalog.version, catalog.beta);
      await installationCheck(dsm, catalog, true);
      const taskId = await startInstallation(dsm, catalog, "upgrade");
      ctx.task_id = taskId;
      const downloadedPath = await waitForDownloadAndGetPath(dsm, taskId);
      ctx.downloaded_path = downloadedPath;
      await applyDownloadedUpgrade(dsm, catalog, downloadedPath);
      const after = await waitForVersionFlip(dsm, catalog.id, catalog.version);
      await cleanupUpgradeTmp(dsm, downloadedPath);
      const ok = after?.version === catalog.version;
      return {
        after,
        ok,
        error: ok
          ? undefined
          : `Post-state: expected ${catalog.version}, observed ${after?.version ?? "<not installed>"}`,
      };
    }
  );

  return { before, after, verified: ok };
}

export async function nasPackageInstall(
  cfg: Config,
  dsm: DsmClient,
  args: { name: string; version?: string }
) {
  refuseIfProtected(args.name);
  const [before, catalog] = await Promise.all([
    listOneState(dsm, args.name),
    findInCatalog(dsm, args.name),
  ]);
  if (before) {
    throw new Error(
      `Package "${args.name}" is already installed (version ${before.version}). Use nas_package_update to upgrade.`
    );
  }

  const { after, ok } = await withAudit(
    cfg,
    { tool: "nas_package_install", args: { ...args, target_version: catalog.version }, before },
    async (ctx) => {
      // Mirror the verified DSM UI sequence — preflight, queue, check, then the
      // single-call install. blupgrade=false here vs upgrade flow's =true.
      await feasibilityCheck(dsm, catalog.id);
      await getInstallQueue(dsm, catalog.id, catalog.version, catalog.beta);
      const checked = await installationCheck(dsm, catalog, false);
      ctx.volume_path = checked.volumePath;
      const taskId = await startInstallation(dsm, catalog, "install", checked.volumePath);
      ctx.task_id = taskId;
      const after = await waitForInstall(dsm, taskId, catalog.id, catalog.version);
      // Install path is not HAR-verified to the same level as upgrade; we
      // best-effort resolve the staged .spk path so cleanupUpgradeTmp can
      // delete it. If Download.check returns nothing, skip — leftover .spk
      // doesn't hurt anything.
      try {
        const dl = await dsm.call<DownloadCheckResp>({
          api: "SYNO.Core.Package.Installation.Download",
          method: "check",
          version: 1,
          post: true,
          params: { taskid: taskId },
        });
        if (typeof dl?.filename === "string" && dl.filename.length > 0) {
          await cleanupUpgradeTmp(dsm, dl.filename);
        }
      } catch {
        // best-effort
      }
      const ok = after?.version === catalog.version;
      return {
        after,
        ok,
        error: ok
          ? undefined
          : `Post-state: expected ${catalog.version}, observed ${after?.version ?? "<not installed>"}`,
      };
    }
  );

  return { before, after, verified: ok };
}

/** SYNO.Core.Package.Control wrapper. Idempotent: DSM returns success for
 *  already-stopped/started packages. POST is required (GET fails). DSM may
 *  drop the TCP connection mid-execution on state changes; we treat
 *  network-level errors as soft and confirm via a follow-up status poll
 *  against the target predicate. */
async function controlPackage(
  dsm: DsmClient,
  packageId: string,
  method: "start" | "stop",
  desired: (status: string | undefined) => boolean
): Promise<void> {
  try {
    await dsm.call({
      api: "SYNO.Core.Package.Control",
      method,
      version: 1,
      post: true,
      params: { id: packageId },
    });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    const isNetwork = /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
    if (!isNetwork) throw err;
    console.error(
      `[packages] ${method} ${packageId}: connection dropped — verifying via poll`
    );
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const s = await listOneState(dsm, packageId);
    if (!s) return; // package gone (e.g. uninstalled mid-call)
    if (desired(s.status)) return;
    await sleep(1000);
  }
  throw new Error(
    `${method} ${packageId} timed out after 30s waiting for status to flip`
  );
}

async function stopPackage(dsm: DsmClient, packageId: string): Promise<void> {
  return controlPackage(dsm, packageId, "stop", (s) => s !== "running");
}

async function startPackage(dsm: DsmClient, packageId: string): Promise<void> {
  return controlPackage(dsm, packageId, "start", (s) => s === "running");
}

export async function nasPackageControl(
  cfg: Config,
  dsm: DsmClient,
  args: { name: string; action: "start" | "stop" | "restart" }
) {
  refuseIfProtected(args.name);
  const before = await listOneState(dsm, args.name);
  if (!before) {
    throw new Error(
      `Package "${args.name}" is not installed; nothing to ${args.action}.`
    );
  }

  const { after, ok } = await withAudit(
    cfg,
    { tool: "nas_package_control", args, before },
    async () => {
      let after: PackageState;
      let ok: boolean;
      if (args.action === "stop") {
        if (before.status !== "running") {
          // No-op; record as ok for idempotency.
          after = before;
          ok = true;
        } else {
          await stopPackage(dsm, args.name);
          after = await listOneState(dsm, args.name);
          ok = after?.status !== "running";
        }
      } else if (args.action === "start") {
        if (before.status === "running") {
          after = before;
          ok = true;
        } else {
          await startPackage(dsm, args.name);
          after = await listOneState(dsm, args.name);
          ok = after?.status === "running";
        }
      } else {
        // Restart implemented client-side as stop-then-start; DSM's native
        // `Package.Control.restart` method isn't reliably exposed across DSM
        // versions, so we drive it from primitives.
        if (before.status === "running") await stopPackage(dsm, args.name);
        await startPackage(dsm, args.name);
        after = await listOneState(dsm, args.name);
        ok = after?.status === "running";
      }
      return {
        after,
        ok,
        error: ok
          ? undefined
          : `Post-state mismatch: action=${args.action} expected running=${args.action !== "stop"}, got status=${after?.status ?? "<gone>"}`,
      };
    }
  );

  return { before, after, verified: ok };
}

export async function nasPackageUninstall(
  cfg: Config,
  dsm: DsmClient,
  args: { name: string }
) {
  refuseIfProtected(args.name);
  const before = await listOneState(dsm, args.name);
  if (!before) {
    throw new Error(`Package "${args.name}" is not installed; nothing to uninstall.`);
  }

  let stopped = false;
  const { after, ok } = await withAudit(
    cfg,
    { tool: "nas_package_uninstall", args, before },
    async (ctx) => {
      // Stop the package first if it's running. DSM's Uninstallation handler
      // can stop in-flight, but explicit stop-then-uninstall is the safer
      // sequence (matches the DSM UI behaviour exactly).
      if (before.status === "running") {
        await stopPackage(dsm, args.name);
        stopped = true;
      }
      ctx.stopped = stopped;
      await dsm.call({
        api: "SYNO.Core.Package.Uninstallation",
        method: "uninstall",
        version: 1,
        post: true,
        params: { id: args.name, dsm_apps: "" },
      });
      const after = await waitForState(dsm, args.name, (s) => s == null);
      const ok = after == null;
      return {
        after,
        ok,
        error: ok
          ? undefined
          : `Post-state: package "${args.name}" still installed after uninstall (version ${after?.version}).`,
      };
    }
  );

  return { before, after, removed: ok, stopped };
}
