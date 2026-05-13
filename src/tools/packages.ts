/**
 * Package Center tools — reads + write tools (install, uninstall, update).
 *
 * == Upgrade flow (the part that took multiple sessions to nail) ==
 *
 * The DSM UI's actual upgrade sequence — reverse-engineered from a captured
 * HAR file in v0.2.11 — is NOT what N4S4's docs describe. There is no
 * separate "download phase that yields a task_id" followed by an upgrade
 * call. The upgrade call IS the orchestration:
 *
 *   1. SYNO.Core.Package.feasibility_check   (preflight, returns {success:true})
 *   2. SYNO.Core.Package.Installation.get_queue
 *      → returns queue + any broken/conflicted/paused packages
 *   3. SYNO.Core.Package.Installation.check (version=2!)
 *      → returns volume_path for upgrades
 *   4. SYNO.Core.Package.Installation.upgrade  ← THIS is the call that does it.
 *      params include `operation="upgrade"`, `url`, `checksum`, `filesize`,
 *      `is_syno`, `beta` — all sourced from the catalog. NO `task_id`.
 *   5. Poll SYNO.Core.Package.Installation.status until finished
 *   6. SYNO.Core.Package.Installation.delete cleans up the tmp file (optional)
 *
 * Param values are JSON-encoded in the form body (DSM JSON-parses each one):
 * strings carry quotes (`name="FileStation"`), bools/numbers/null are literal,
 * arrays/objects are JSON-stringified.
 *
 * Prior attempts that DID NOT work: single-call `upgrade?id=…`,
 * `upgrade(task_id=…)` after a separate Installation.install download,
 * SYNO.Entry.Request batch_request compounds, JSON-body POSTs, browser-
 * impersonation with SynoToken/Cookie. All returned `{success:true,
 * progress:1, taskid:"@SYNOPKG_DOWNLOAD_<name>"}` — but never applied the
 * upgrade. v0.2.10 shipped a HITL fallback; v0.2.11+ has the real flow.
 *
 * APIs used:
 *   SYNO.Core.Package                       v2  list installed; v1 feasibility_check
 *   SYNO.Core.Package.Server                v2  catalog (link/md5/size + flags)
 *   SYNO.Core.Package.Installation          v1  upgrade / status / delete
 *                                           v2  check (returns volume_path)
 *   SYNO.Core.Package.Installation.get_queue (on Installation, v1)
 *   SYNO.Core.Package.Uninstallation        v1  uninstall
 */

import type { Config } from "../config.js";
import type { DsmClient } from "../dsm.js";
import { recordWrite } from "../audit.js";

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

// DSM 7's Package.list response nests `status` AND `is_system_ish` info under
// `additional`, not at the top level. Previous versions of this tool read
// `p.status` and `p.is_system_package` — both fields don't exist, so every
// package came back with status=undefined and is_system=false. Real signal:
//   - status: `additional.status` ("running" / "stop" / etc.)
//   - is_system: `additional.install_type === "system"` (DSM-bundled, can't
//     be uninstalled via Package Center even if it appears in the UI)
//   - startable: `additional.startable` (can be stopped via Package.Control)
export async function nasPackagesList(dsm: DsmClient) {
  const data = await dsm.call({
    api: "SYNO.Core.Package",
    method: "list",
    version: 2,
    params: {
      additional: '["description","status","beta","install_type","startable"]',
    },
  });
  return {
    packages: (data?.packages ?? []).map((p: any) => ({
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
    dsm.call<any>({
      api: "SYNO.Core.Package",
      method: "list",
      version: 2,
    }),
    dsm.call<any>({
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

export async function nasPackageInfo(
  dsm: DsmClient,
  args: { name: string }
) {
  const data = await dsm.call({
    api: "SYNO.Core.Package.Server",
    method: "get",
    version: 2,
    params: { id: args.name },
  });
  return {
    id: data?.id,
    name: data?.name,
    version: data?.version,
    publisher: data?.publisher,
    description: data?.description,
    changelog: data?.changelog,
    dependencies: data?.depend_packages,
    install_dep_packages: data?.install_dep_packages,
    size: data?.size,
    beta: data?.beta,
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
  const data = await dsm.call<any>({
    api: "SYNO.Core.Package.Server",
    method: "list",
    version: 2,
    params: { tab: "all" },
  });
  const pkg = (data?.packages ?? []).find(
    (p: any) => p.id === packageId || p.name === packageId
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

async function waitForState(
  dsm: DsmClient,
  packageId: string,
  predicate: (state: any | null) => boolean
): Promise<any | null> {
  const deadline = Date.now() + POSTOP_VERIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await listOneState(dsm, packageId);
    if (predicate(state)) return state;
    await sleep(POSTOP_POLL_MS);
  }
  return await listOneState(dsm, packageId);
}

async function listOneState(dsm: DsmClient, name: string) {
  const all = await nasPackagesList(dsm);
  return (
    all.packages.find((p: any) => p.id === name || p.name === name) ?? null
  );
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
  const res = await dsm.call<any>({
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
    const arr = (res as any)?.[key];
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
  const res = await dsm.call<any>({
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
  const vp = (res as any)?.volume_path;
  return { volumePath: typeof vp === "string" ? vp : "" };
}

const installationCheckUpgrade = (dsm: DsmClient, c: CatalogEntry) =>
  installationCheck(dsm, c, true);
const installationCheckInstall = (dsm: DsmClient, c: CatalogEntry) =>
  installationCheck(dsm, c, false);

/** The actual upgrade call — same endpoint that triggers the download AND
 *  orchestrates the install. NO separate task_id is involved; this is the
 *  whole thing. */
async function startUpgrade(
  dsm: DsmClient,
  catalog: CatalogEntry
): Promise<string> {
  const res = await dsm.call<any>({
    api: "SYNO.Core.Package.Installation",
    method: "upgrade",
    version: 1,
    post: true,
    params: {
      name: JSON.stringify(catalog.id),
      is_syno: catalog.source === "syno",
      beta: catalog.beta,
      url: JSON.stringify(catalog.link),
      checksum: JSON.stringify(catalog.md5),
      filesize: catalog.size,
      type: 0,
      blqinst: false,
      operation: JSON.stringify("upgrade"),
    },
  });
  const taskId = (res as any)?.taskid;
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new Error(
      `Installation.upgrade did not return a taskid; got: ${JSON.stringify(res)}`
    );
  }
  return taskId;
}

/** Poll status until DSM reports finished + the installed version flips. The
 *  status endpoint reports `status:"upgrading"` long after the version has
 *  actually swapped, so the version-flip on Package.list is the source of
 *  truth — status `finished:true` is the secondary signal. */
async function waitForUpgrade(
  dsm: DsmClient,
  taskId: string,
  packageId: string,
  targetVersion: string
): Promise<any> {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  let lastProgress = -1;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const s = await dsm.call<any>({
      api: "SYNO.Core.Package.Installation",
      method: "status",
      version: 1,
      post: true,
      params: { task_id: taskId },
    });
    const progress = Number((s as any)?.progress ?? 0);
    const status = String((s as any)?.status ?? "");
    if (progress !== lastProgress || status !== lastStatus) {
      console.error(
        `[packages] upgrade ${taskId} progress=${(progress * 100).toFixed(1)}% status=${status}`
      );
      lastProgress = progress;
      lastStatus = status;
    }
    if ((s as any)?.success === false) {
      throw new Error(`Upgrade failed mid-flight: ${JSON.stringify(s)}`);
    }
    // The version flip on Package.list is the definitive completion signal.
    const live = await listOneState(dsm, packageId);
    if (live?.version === targetVersion) return live;
    await sleep(DOWNLOAD_POLL_MS);
  }
  throw new Error(
    `Upgrade timeout after ${DOWNLOAD_TIMEOUT_MS / 1000}s; package still at old version`
  );
}

/** Cleanup the .spk file DSM staged into /run/synopkg/tmp/. The DSM UI does
 *  this last; best-effort here (we don't fail the whole upgrade if it 4xx's). */
async function cleanupUpgradeTmp(
  dsm: DsmClient,
  taskId: string
): Promise<void> {
  try {
    const dl = await dsm.call<any>({
      api: "SYNO.Core.Package.Installation.Download",
      method: "check",
      version: 1,
      post: true,
      params: { taskid: taskId },
    });
    const path = (dl as any)?.filename;
    if (typeof path !== "string" || path.length === 0) return;
    await dsm.call({
      api: "SYNO.Core.Package.Installation",
      method: "delete",
      version: 1,
      post: true,
      params: { path: JSON.stringify(path) },
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
  const before = await listOneState(dsm, args.name);
  if (!before) {
    throw new Error(
      `Package "${args.name}" is not installed. Use nas_package_install for fresh installs.`
    );
  }
  const catalog = await findInCatalog(dsm, args.name);
  if (catalog.version === before.version) {
    throw new Error(
      `Package "${args.name}" is already at the latest version (${before.version}); no update available.`
    );
  }

  let after: any = null;
  let ok = false;
  let error: string | undefined;
  let taskId: string | undefined;

  try {
    // Match the DSM UI's exact sequence (verified from HAR capture).
    await feasibilityCheck(dsm, catalog.id);
    await getInstallQueue(dsm, catalog.id, catalog.version, catalog.beta);
    await installationCheckUpgrade(dsm, catalog);
    taskId = await startUpgrade(dsm, catalog);
    after = await waitForUpgrade(dsm, taskId, catalog.id, catalog.version);
    await cleanupUpgradeTmp(dsm, taskId);
    ok = after?.version === catalog.version;
    if (!ok) {
      error = `Post-state: expected ${catalog.version}, observed ${after?.version ?? "<not installed>"}`;
    }
  } catch (err: any) {
    error = String(err?.message ?? err);
    throw err;
  } finally {
    await recordWrite(cfg, {
      tool: "nas_package_update",
      args: { ...args, target_version: catalog.version, task_id: taskId },
      before,
      after,
      ok,
      error,
    });
  }

  return { before, after, verified: ok };
}

/** Fresh-install equivalent of `startUpgrade` — same single-call orchestration
 *  shape DSM's UI uses, with `method=install` + `operation="install"`. NOT
 *  HAR-verified for install yet (we only captured an upgrade), but the
 *  symmetric assumption is the same DSM Package Center JS code path; the
 *  prior multi-step "download then install with path" implementation was
 *  the wrong shape — same failure mode as our pre-v0.2.11 upgrade. */
async function startInstall(
  dsm: DsmClient,
  catalog: CatalogEntry,
  volumePath: string
): Promise<string> {
  const res = await dsm.call<any>({
    api: "SYNO.Core.Package.Installation",
    method: "install",
    version: 1,
    post: true,
    params: {
      name: JSON.stringify(catalog.id),
      is_syno: catalog.source === "syno",
      beta: catalog.beta,
      url: JSON.stringify(catalog.link),
      checksum: JSON.stringify(catalog.md5),
      filesize: catalog.size,
      type: 0,
      blqinst: false,
      operation: JSON.stringify("install"),
      volume_path: JSON.stringify(volumePath),
    },
  });
  const taskId = (res as any)?.taskid;
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new Error(
      `Installation.install did not return a taskid; got: ${JSON.stringify(res)}`
    );
  }
  return taskId;
}

/** Same predicate-poll as upgrade — version flip on Package.list is the
 *  definitive completion signal for install too. */
async function waitForInstall(
  dsm: DsmClient,
  taskId: string,
  packageId: string,
  targetVersion: string
): Promise<any> {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  let lastProgress = -1;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const s = await dsm.call<any>({
      api: "SYNO.Core.Package.Installation",
      method: "status",
      version: 1,
      post: true,
      params: { task_id: taskId },
    });
    const progress = Number((s as any)?.progress ?? 0);
    const status = String((s as any)?.status ?? "");
    if (progress !== lastProgress || status !== lastStatus) {
      console.error(
        `[packages] install ${taskId} progress=${(progress * 100).toFixed(1)}% status=${status}`
      );
      lastProgress = progress;
      lastStatus = status;
    }
    if ((s as any)?.success === false) {
      throw new Error(`Install failed mid-flight: ${JSON.stringify(s)}`);
    }
    const live = await listOneState(dsm, packageId);
    if (live?.version === targetVersion) return live;
    await sleep(DOWNLOAD_POLL_MS);
  }
  throw new Error(
    `Install timeout after ${DOWNLOAD_TIMEOUT_MS / 1000}s; package not yet showing in Package.list`
  );
}

export async function nasPackageInstall(
  cfg: Config,
  dsm: DsmClient,
  args: { name: string; version?: string }
) {
  refuseIfProtected(args.name);
  const before = await listOneState(dsm, args.name);
  if (before) {
    throw new Error(
      `Package "${args.name}" is already installed (version ${before.version}). Use nas_package_update to upgrade.`
    );
  }

  const catalog = await findInCatalog(dsm, args.name);

  let after: any = null;
  let ok = false;
  let error: string | undefined;
  let volumePath: string | undefined;
  let taskId: string | undefined;

  try {
    // Mirror the verified DSM UI sequence — preflight, queue, check, then the
    // single-call install. blupgrade=false here vs upgrade flow's =true.
    await feasibilityCheck(dsm, catalog.id);
    await getInstallQueue(dsm, catalog.id, catalog.version, catalog.beta);
    const checked = await installationCheckInstall(dsm, catalog);
    volumePath = checked.volumePath;
    taskId = await startInstall(dsm, catalog, volumePath);
    after = await waitForInstall(dsm, taskId, catalog.id, catalog.version);
    await cleanupUpgradeTmp(dsm, taskId);
    ok = after?.version === catalog.version;
    if (!ok) {
      error = `Post-state: expected ${catalog.version}, observed ${after?.version ?? "<not installed>"}`;
    }
  } catch (err: any) {
    error = String(err?.message ?? err);
    throw err;
  } finally {
    await recordWrite(cfg, {
      tool: "nas_package_install",
      args: { ...args, target_version: catalog.version, volume_path: volumePath, task_id: taskId },
      before,
      after,
      ok,
      error,
    });
  }

  return { before, after, verified: ok };
}

/** Stop a running package via SYNO.Core.Package.Control. Idempotent — DSM
 *  returns success for already-stopped packages. POST is required (GET
 *  fails). DSM frequently drops the TCP connection mid-execution when
 *  stopping a package whose services were active; the stop still completes
 *  server-side, so we treat "fetch failed" as a soft signal and confirm via
 *  a follow-up status poll. */
async function stopPackage(dsm: DsmClient, packageId: string): Promise<void> {
  try {
    await dsm.call({
      api: "SYNO.Core.Package.Control",
      method: "stop",
      version: 1,
      post: true,
      params: { id: packageId },
    });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // Network-level failures (fetch failed, ECONNRESET, etc.) — likely DSM
    // dropped the connection mid-stop. Don't bail; verify via poll below.
    const isNetwork = /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
    if (!isNetwork) throw err;
    console.error(`[packages] stop ${packageId}: connection dropped — verifying via poll`);
  }
  // Poll for status to flip from "running"; tolerate up to 30s.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const s = await listOneState(dsm, packageId);
    if (!s || s.status !== "running") return;
    await sleep(1000);
  }
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

  let after: any = null;
  let ok = false;
  let error: string | undefined;
  let stopped = false;

  try {
    // Stop the package first if it's running. DSM's Uninstallation handler
    // can stop in-flight, but explicit stop-then-uninstall is the safer
    // sequence (matches the DSM UI behaviour exactly).
    if (before.status === "running") {
      await stopPackage(dsm, args.name);
      stopped = true;
    }
    await dsm.call({
      api: "SYNO.Core.Package.Uninstallation",
      method: "uninstall",
      version: 1,
      post: true,
      params: { id: args.name, dsm_apps: "" },
    });
    after = await waitForState(dsm, args.name, (s) => s == null);
    ok = after == null;
    if (!ok) {
      error = `Post-state: package "${args.name}" still installed after uninstall (version ${after?.version}).`;
    }
  } catch (err: any) {
    error = String(err?.message ?? err);
    throw err;
  } finally {
    await recordWrite(cfg, {
      tool: "nas_package_uninstall",
      args: { ...args, stopped },
      before,
      after,
      ok,
      error,
    });
  }

  return { before, after, removed: ok, stopped };
}
