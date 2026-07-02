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
import type { SynoClient } from "../dsm.js";
import { DsmError } from "../dsm.js";
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

/** One entry in DSM's resolved install queue. DSM transitively resolves
 *  dependencies server-side and returns the full ordered plan (deps first,
 *  target last), so executing this flat list mirrors Package Center's
 *  "the following operations will also be performed" install exactly. */
interface QueueItem {
  pkg: string;
  beta?: boolean;
  volume?: string;
}

interface QueueResp {
  broken_pkgs?: unknown[];
  conflicted_pkgs?: unknown[];
  non_exist_pkgs?: unknown[];
  paused_pkgs?: unknown[];
  queue?: QueueItem[];
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
    /** True when the package ships a custom uninstall dialog (the one offering
     *  to delete its data). Surfaced so uninstall can warn the user. */
    is_uninstall_pages?: boolean;
  };
}

interface CatalogPackage {
  id: string;
  version: string;
  link?: string;
  md5?: string;
  size?: number | string;
  source?: string;
  beta?: boolean;
  install_type?: string;
  install_on_cold_storage?: boolean;
  changelog?: string;
  /** Display name — HAR-verified 2026-07-01: this API names it `dname`, not
   *  `name` (that's `SYNO.Core.Package.list`'s field, a different endpoint). */
  dname?: string;
  /** Publisher — HAR-verified: `maintainer`, not `publisher`. */
  maintainer?: string;
  /** Description — HAR-verified: `desc`, not `description`. */
  desc?: string;
  /** Dependency map (`{pkgId: versionConstraint}` or null) — HAR-verified:
   *  `deppkgs`, not `depend_packages`. No `install_dep_packages` field exists
   *  on this endpoint at all; `Installation.get_queue` is the source of truth
   *  for the resolved install plan (see the write-flow doc comment above). */
  deppkgs?: unknown;
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

// Install-flow waits are deliberately tighter than the upgrade flow's 15-min
// budget. The MCP call rides a single streamable-HTTP response with no SSE
// heartbeats, so the client's undici bodyTimeout (~300s) drops the connection
// if nothing returns. Synology-repo packages download + commit in seconds, so
// these bounds fit comfortably inside the transport window and turn the old
// silent 15-min hang into a fast, clear "issued but not confirmed — poll
// nas_packages_list" error on the rare pathological case.
const INSTALL_DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000; // 3 min — .spk fetch
const INSTALL_VERIFY_TIMEOUT_MS = 90 * 1000; // 90s — version flip after commit

/** A "soft" transport error on a state-changing POST: the request didn't get a
 *  clean DSM response, but the mutation likely completed server-side, so the
 *  caller should confirm via a status/list poll rather than fail. Covers both
 *  the mid-commit TCP drop DSM is known for (ECONNRESET / socket hang up /
 *  undici "terminated" / "fetch failed") AND the per-call AbortSignal.timeout
 *  in dsm.ts, which rejects with an AbortError/TimeoutError whose message none
 *  of the network patterns match — without this the 30s bound would turn a
 *  slow-but-successful commit into a hard failure. */
function isSoftTransportError(err: unknown): boolean {
  // A DsmError means DSM *answered* (app-level failure) — the mutation outcome
  // is known, so never treat it as a soft transport drop even if its embedded
  // error JSON happens to contain words like "aborted"/"terminated".
  if (err instanceof DsmError) return false;
  const e = err as { name?: string; message?: string } | null;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return true;
  const msg = String(e?.message ?? err);
  return /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|terminated|timed out|aborted/i.test(
    msg
  );
}

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
export async function nasPackagesList(dsm: SynoClient) {
  const data = await dsm.call<PackageListResp>({
    api: "SYNO.Core.Package",
    method: "list",
    version: 2,
    params: {
      additional:
        '["description","status","beta","install_type","startable","is_uninstall_pages"]',
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
        // True when the package ships the uninstall dialog that offers to delete
        // its data — surfaced so nas_package_uninstall can gate on it without a
        // second Package.list round-trip.
        has_uninstall_dialog: p.additional?.is_uninstall_pages === true,
      },
    })),
  };
}

export async function nasPackagesCheckUpdates(dsm: SynoClient) {
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
      name: p.dname || p.id,
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
  dsm: SynoClient,
  args: { name: string }
) {
  const data = await dsm.call<CatalogListResp>({
    api: "SYNO.Core.Package.Server",
    method: "list",
    version: 2,
    params: { tab: "all" },
  });
  const pkg = (data?.packages ?? []).find(
    (p) => p.id === args.name || p.dname === args.name
  );
  if (!pkg) {
    throw new Error(
      `Package "${args.name}" not found in the Synology repo catalog for this DS.`
    );
  }
  return {
    id: pkg.id,
    name: pkg.dname || pkg.id,
    version: pkg.version,
    publisher: pkg.maintainer,
    description: pkg.desc,
    changelog: pkg.changelog,
    dependencies: pkg.deppkgs,
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
  dsm: SynoClient,
  packageId: string
): Promise<CatalogEntry> {
  const data = await dsm.call<CatalogListResp>({
    api: "SYNO.Core.Package.Server",
    method: "list",
    version: 2,
    params: { tab: "all" },
  });
  const pkg = (data?.packages ?? []).find(
    (p) => p.id === packageId || p.dname === packageId
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
    name: pkg.dname || pkg.id,
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

async function listOneState(dsm: SynoClient, name: string) {
  const all = await nasPackagesList(dsm);
  return all.packages.find((p) => p.id === name || p.name === name) ?? null;
}

type PackageState = Awaited<ReturnType<typeof listOneState>>;

async function waitForState(
  dsm: SynoClient,
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
  dsm: SynoClient,
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

/** Ask DSM to plan the install queue. Throws on broken/conflicted/paused
 *  packages (a known dep problem). Returns DSM's resolved ordered queue —
 *  dependencies first, target last — which the install flow executes verbatim.
 *  The catalog's `depend_packages` field is unreliable (it was `null` for
 *  Synology Drive Server, which nonetheless requires Universal Viewer); the
 *  queue is the only honest source of the dependency set. */
async function getInstallQueue(
  dsm: SynoClient,
  packageId: string,
  version: string,
  beta: boolean
): Promise<QueueItem[]> {
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
        `Cannot install ${packageId}: ${key.replace("_pkgs", "")} = ${JSON.stringify(arr)}`
      );
    }
  }
  return Array.isArray(res?.queue) ? res.queue : [];
}

/** Installation.check v=2 — preflight that returns the volume_path DSM will
 *  install into. We pass the package metadata from the catalog so DSM can
 *  validate dep/size/etc. `blupgrade` differs for install vs upgrade flows. */
async function installationCheck(
  dsm: SynoClient,
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
 *  This call only DOWNLOADS — for BOTH modes. Verified against the live NAS:
 *  after `Installation.install` returns and status flips to "installing",
 *  Download.check still reports the package as `status:"non_installed"` /
 *  "failed to locate given package", and it never lands in Package.list. The
 *  actual commit is the second-phase call (applyDownloadedUpgrade /
 *  applyInstallFromPath) with `installrunpackage:true`. */
async function startInstallation(
  dsm: SynoClient,
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
  dsm: SynoClient,
  taskId: string,
  timeoutMs: number = DOWNLOAD_TIMEOUT_MS
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
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
    `Download timeout after ${timeoutMs / 1000}s; .spk never finished staging`
  );
}

/** Phase 2 of upgrade: lightweight preflight + the install-from-path call.
 *  The HAR has these batched in a SYNO.Entry.Request compound; sending them
 *  as separate sequential POSTs is equivalent (DSM doesn't gate the upgrade
 *  on the check having shared a request). */
async function applyDownloadedUpgrade(
  dsm: SynoClient,
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

/** Fresh-install equivalent of `applyDownloadedUpgrade`: the second-phase
 *  commit. Step 4's `Installation.install` only DOWNLOADS the .spk (verified
 *  against the live NAS — the package reports `status:"non_installed"`,
 *  "failed to locate given package", and never lands in Package.list). This
 *  second `Installation.install` with `path` + `installrunpackage:true` is what
 *  actually commits it. Differs from the upgrade apply by method (`install` not
 *  `upgrade`) and by passing `volume_path` for the install target.
 *
 *  DSM frequently drops the TCP connection mid-commit while finishing
 *  server-side (the documented Package.* POST quirk) — observed on Synology
 *  Drive Server, which registers many `dsm_apps`. Network-level errors are
 *  therefore soft: we log and let the caller's Package.list poll confirm. Any
 *  DSM-level error (a real failure) still propagates. */
async function applyInstallFromPath(
  dsm: SynoClient,
  catalog: CatalogEntry,
  downloadedPath: string,
  volumePath: string
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
  const params: Record<string, string | number | boolean> = {
    path: JSON.stringify(downloadedPath),
    extra_values: JSON.stringify("{}"),
    type: 0,
    check_codesign: true,
    force: true,
    installrunpackage: true,
  };
  if (volumePath) params.volume_path = JSON.stringify(volumePath);
  let res: ApplyUpgradeResp | undefined;
  try {
    res = await dsm.call<ApplyUpgradeResp>({
      api: "SYNO.Core.Package.Installation",
      method: "install",
      version: 1,
      post: true,
      params,
    });
  } catch (err: any) {
    if (!isSoftTransportError(err)) throw err;
    console.error(
      `[packages] install-from-path ${catalog.id}: connection dropped mid-commit — verifying via Package.list poll`
    );
  }
  // Checked OUTSIDE the try: a populated worker_message is a genuine DSM-level
  // install failure and must propagate — it must never be caught by the
  // soft-transport handler (whose broadened match could otherwise swallow a
  // worker message that happens to contain "aborted"/"timed out"/"terminated").
  if (res && Array.isArray(res.worker_message) && res.worker_message.length > 0) {
    throw new Error(
      `Install-from-path returned worker_message: ${JSON.stringify(res.worker_message)}`
    );
  }
}

/** Two-phase install of a single package: check → download → resolve staged
 *  path → install-from-path → verify the version flip → clean up the .spk.
 *  Used for both the target and each resolved dependency. Throws (bounded) if
 *  the package never lands within INSTALL_VERIFY_TIMEOUT_MS. */
async function installOnePackage(
  dsm: SynoClient,
  catalog: CatalogEntry
): Promise<PackageState> {
  console.error(`[packages] install ${catalog.id} ${catalog.version}: check`);
  const { volumePath } = await installationCheck(dsm, catalog, false);
  console.error(`[packages] install ${catalog.id}: download`);
  const taskId = await startInstallation(dsm, catalog, "install", volumePath);
  const downloadedPath = await waitForDownloadAndGetPath(
    dsm,
    taskId,
    INSTALL_DOWNLOAD_TIMEOUT_MS
  );
  console.error(`[packages] install ${catalog.id}: commit (install-from-path)`);
  await applyInstallFromPath(dsm, catalog, downloadedPath, volumePath);
  console.error(`[packages] install ${catalog.id}: verify version flip`);
  const after = await waitForVersionFlip(
    dsm,
    catalog.id,
    catalog.version,
    INSTALL_VERIFY_TIMEOUT_MS
  );
  await cleanupUpgradeTmp(dsm, downloadedPath);
  return after;
}

/** Poll Package.list until the version flips to the target. The status
 *  endpoint reports `status:"upgrading"` long after the swap has happened
 *  server-side, so Package.list is the authoritative signal. */
async function waitForVersionFlip(
  dsm: SynoClient,
  packageId: string,
  targetVersion: string,
  timeoutMs: number = DOWNLOAD_TIMEOUT_MS
): Promise<PackageState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = await listOneState(dsm, packageId);
    if (live?.version === targetVersion) return live;
    await sleep(DOWNLOAD_POLL_MS);
  }
  throw new Error(
    `Install of ${packageId} issued but not confirmed within ${timeoutMs / 1000}s ` +
      `(package not yet at ${targetVersion} in Package.list). DSM may still be ` +
      `committing — re-check with nas_packages_list before retrying.`
  );
}

/** Cleanup the .spk file DSM staged into /volume1/@tmp/synopkg/. The DSM UI
 *  does this last; best-effort here (we don't fail the whole upgrade if it
 *  4xx's). */
async function cleanupUpgradeTmp(
  dsm: SynoClient,
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
  dsm: SynoClient,
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
  dsm: SynoClient,
  args: { name: string; version?: string; accept_dependencies?: boolean }
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

  // Non-mutating preflight: ask DSM to resolve the install plan. feasibility +
  // get_queue download and change nothing on the NAS, so it's safe to return
  // the plan here without an audit record (we only audit actual mutations).
  await feasibilityCheck(dsm, catalog.id);
  const queue = await getInstallQueue(dsm, catalog.id, catalog.version, catalog.beta);

  // DSM's resolved queue is the dependency set: every entry that isn't the
  // target is a package DSM will pull in. Mirror Package Center's "the
  // following operations will also be performed when X is installed — continue?"
  // dialog: surface the plan and require explicit acknowledgement before we
  // mutate anything.
  const depItems = queue.filter((q) => q.pkg !== catalog.id);
  if (depItems.length > 0 && !args.accept_dependencies) {
    const deps = await Promise.all(
      depItems.map(async (q) => {
        try {
          const c = await findInCatalog(dsm, q.pkg);
          return { id: c.id, version: c.version };
        } catch {
          return { id: q.pkg, version: null as string | null };
        }
      })
    );
    const human = deps
      .map((d) => `${d.id}${d.version ? ` ${d.version}` : ""}`)
      .join(", ");
    return {
      status: "needs_dependency_confirmation",
      target: { id: catalog.id, version: catalog.version },
      will_also_install: deps,
      message:
        `Installing ${catalog.id} (${catalog.version}) requires DSM to also install: ${human}. ` +
        `This is Package Center's "the following operations will also be performed" prompt. ` +
        `Re-run nas_package_install with accept_dependencies:true to install all of them.`,
    };
  }

  // Execute DSM's resolved queue in order (dependencies first, target last),
  // each via the two-phase download→install-from-path flow. Fall back to a
  // bare target install if DSM returned an empty queue.
  const order = queue.map((q) => q.pkg);
  if (!order.includes(catalog.id)) order.push(catalog.id);

  const dependenciesInstalled: Array<{ id: string; version: string }> = [];
  const { after, ok } = await withAudit(
    cfg,
    {
      tool: "nas_package_install",
      args: { ...args, target_version: catalog.version, queue: order },
      before,
    },
    async (ctx) => {
      const completed: string[] = [];
      ctx.queue = order;
      ctx.completed = completed;
      let targetAfter: PackageState = null;
      for (const pkgId of order) {
        const cat =
          pkgId === catalog.id ? catalog : await findInCatalog(dsm, pkgId);
        const state = await installOnePackage(dsm, cat);
        completed.push(pkgId);
        if (pkgId === catalog.id) targetAfter = state;
        else dependenciesInstalled.push({ id: cat.id, version: cat.version });
      }
      const ok = targetAfter?.version === catalog.version;
      return {
        after: targetAfter,
        ok,
        error: ok
          ? undefined
          : `Post-state: expected ${catalog.version}, observed ${targetAfter?.version ?? "<not installed>"}`,
      };
    }
  );

  return { before, after, verified: ok, dependencies_installed: dependenciesInstalled };
}

/** SYNO.Core.Package.Control wrapper. Idempotent: DSM returns success for
 *  already-stopped/started packages. POST is required (GET fails). DSM may
 *  drop the TCP connection mid-execution on state changes; we treat
 *  network-level errors as soft and confirm via a follow-up status poll
 *  against the target predicate. */
async function controlPackage(
  dsm: SynoClient,
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
    if (!isSoftTransportError(err)) throw err;
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

async function stopPackage(dsm: SynoClient, packageId: string): Promise<void> {
  return controlPackage(dsm, packageId, "stop", (s) => s !== "running");
}

async function startPackage(dsm: SynoClient, packageId: string): Promise<void> {
  return controlPackage(dsm, packageId, "start", (s) => s === "running");
}

export async function nasPackageControl(
  cfg: Config,
  dsm: SynoClient,
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
  dsm: SynoClient,
  args: { name: string; keep_data?: boolean }
) {
  refuseIfProtected(args.name);
  const before = await listOneState(dsm, args.name);
  if (!before) {
    throw new Error(`Package "${args.name}" is not installed; nothing to uninstall.`);
  }

  // Mirror Package Center's uninstall dialog: a package with the uninstall
  // dialog (`has_uninstall_dialog`, already carried by `before` from the initial
  // Package.list read) offers to delete its data. That deletion rides
  // `extra_values` with a PACKAGE-SPECIFIC key (`pkgwizard_remove_cstn_db` for
  // Synology Drive, different per package) defined in the package's own
  // client-side wizard — not exposed by any queryable API. So the human chooses:
  // proceed with the default data-preserving uninstall, or go to the DSM UI to
  // delete the data. The MCP only ever does the data-preserving uninstall (the
  // delete key is unsafe to drive blind), so deletion is always routed to the UI.
  const hadDataDialog = before.additional?.has_uninstall_dialog === true;
  if (hadDataDialog) {
    if (args.keep_data === false) {
      throw new Error(
        `Deleting "${args.name}"'s data on uninstall isn't supported via the MCP — ` +
          `the delete option is package-specific. To remove its data, uninstall via ` +
          `Package Center (DSM UI) and check "Delete the items listed above". ` +
          `Re-run with keep_data:true to uninstall while PRESERVING the data.`
      );
    }
    if (args.keep_data === undefined) {
      return {
        status: "needs_data_confirmation",
        package: { id: before.id, version: before.version },
        message:
          `"${args.name}" stores associated data and settings. Uninstalling via the ` +
          `MCP removes the package but PRESERVES that data on disk. To also DELETE ` +
          `the data, uninstall via Package Center (DSM UI) — that option is ` +
          `package-specific and not exposed safely through the API. Re-run ` +
          `nas_package_uninstall with keep_data:true to proceed (data kept).`,
      };
    }
    // keep_data === true → proceed with the default, data-preserving uninstall.
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

  // The MCP never deletes data, so an uninstall is *always* data-preserving;
  // `had_data_dialog` reports whether this package had the deletable-data option
  // (i.e. whether data was left behind that the UI could have removed).
  return { before, after, removed: ok, stopped, had_data_dialog: hadDataDialog };
}
