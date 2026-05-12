/**
 * Package Center tools. Reads: list, check_updates, info. Writes: install,
 * uninstall, update — all real in v0.2+.
 *
 * Install/upgrade is a multi-step DSM API flow:
 *   1. Look up the catalog entry for the target id → url, md5, size.
 *   2. SYNO.Core.Package.Installation.install (operation=install) → task_id.
 *   3. Poll SYNO.Core.Package.Installation.status until finished.
 *   4. SYNO.Core.Package.Installation.Download.check task_id → filename.
 *   5a. (fresh install) SYNO.Core.Package.Installation.check id → volume_path,
 *       then SYNO.Core.Package.Installation.install with volume_path + filename.
 *   5b. (in-place upgrade) SYNO.Core.Package.Installation.upgrade with task_id.
 *   6. Verify post-state via SYNO.Core.Package.list.
 *
 * Uninstall is a single call: SYNO.Core.Package.Uninstallation.uninstall.
 *
 * Reference: N4S4/synology-api Python lib `core_package.py`.
 */

import type { Config } from "../config.js";
import type { DsmClient } from "../dsm.js";
import { recordWrite } from "../audit.js";

const HARD_REFUSE_NAMES = new Set(["DSM", "kernel"]);

const DOWNLOAD_POLL_MS = 1500;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const POSTOP_VERIFY_TIMEOUT_MS = 90_000; // 90s after install/upgrade/uninstall
const POSTOP_POLL_MS = 2000;

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

export async function nasPackagesList(dsm: DsmClient) {
  const data = await dsm.call({
    api: "SYNO.Core.Package",
    method: "list",
    version: 2,
    params: { additional: '["description","status","beta"]' },
  });
  return {
    packages: (data?.packages ?? []).map((p: any) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      status: p.status,
      additional: {
        description: p.additional?.description,
        beta: p.additional?.beta,
        is_system: !!p.is_system_package,
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
    if (!installedVersion) continue; // not installed on this NAS
    if (installedVersion === p.version) continue; // already current
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

// ──────────── Multi-step write helpers ────────────

interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  link: string;
  md5: string;
  size: number;
  deppkgs?: any;
  beta?: boolean;
}

/** Find a package in the available-catalog by id. Searches the `all` tab so
 *  we can install packages that don't have pending updates too. */
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
      `Package "${packageId}" not found in the Synology repo catalog for this DS. ` +
        `For non-repo packages, install via Package Center → Manual Install with a .spk file.`
    );
  }
  if (!pkg.link || !pkg.md5 || pkg.size == null) {
    throw new Error(
      `Catalog entry for "${packageId}" is missing download metadata (link/md5/size). ` +
        `Apply via DSM Package Center UI instead.`
    );
  }
  return {
    id: pkg.id,
    name: pkg.name,
    version: pkg.version,
    link: pkg.link,
    md5: pkg.md5,
    size: pkg.size,
    deppkgs: pkg.deppkgs,
    beta: pkg.beta,
  };
}

/** Start the download. Returns the task_id used to poll status. */
async function startDownload(
  dsm: DsmClient,
  info: CatalogEntry
): Promise<string> {
  const result = await dsm.call<any>({
    api: "SYNO.Core.Package.Installation",
    method: "install",
    version: 1,
    post: true,
    params: {
      operation: "install",
      type: 0,
      blqinst: false,
      url: info.link,
      name: info.id,
      checksum: info.md5,
      filesize: info.size,
    },
  });
  const taskid = result?.taskid;
  if (!taskid) {
    throw new Error(
      `Download did not start for "${info.id}": ${JSON.stringify(result)}`
    );
  }
  return taskid;
}

/** Poll the install task until DSM reports the download finished. */
async function pollDownloadDone(dsm: DsmClient, taskId: string): Promise<void> {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await dsm.call<any>({
      api: "SYNO.Core.Package.Installation",
      method: "status",
      version: 1,
      params: { task_id: taskId },
    });
    if (status?.has_fail) {
      throw new Error(`DSM reports download failed: ${JSON.stringify(status)}`);
    }
    if (status?.finished) return;
    await sleep(DOWNLOAD_POLL_MS);
  }
  throw new Error(
    `Download did not finish within ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)}s`
  );
}

/** Used only for fresh installs: ask DSM for the on-disk file path after the
 *  download finishes, so we can pass it as `path` to the install call. */
async function getDownloadedFilename(
  dsm: DsmClient,
  taskId: string
): Promise<string> {
  const check = await dsm.call<any>({
    api: "SYNO.Core.Package.Installation.Download",
    method: "check",
    version: 1,
    params: { task_id: taskId },
  });
  const filename = check?.filename;
  if (!filename) {
    throw new Error(
      `Download.check returned no filename: ${JSON.stringify(check)}`
    );
  }
  return filename;
}

/** For fresh install: ask DSM what volume the package should land on. */
async function checkInstallFeasibility(
  dsm: DsmClient,
  packageId: string
): Promise<string> {
  const result = await dsm.call<any>({
    api: "SYNO.Core.Package.Installation",
    method: "check",
    version: 1,
    post: true,
    params: {
      id: packageId,
      install_type: "",
      install_on_cold_storage: false,
      blCheckDep: false,
    },
  });
  const vp = result?.volume_path;
  if (!vp) {
    throw new Error(
      `Install feasibility check did not return a volume_path: ${JSON.stringify(result)}`
    );
  }
  return vp;
}

/** Apply a fresh install (the package wasn't installed before). */
async function applyInstall(
  dsm: DsmClient,
  volumePath: string,
  filePath: string
): Promise<void> {
  await dsm.call({
    api: "SYNO.Core.Package.Installation",
    method: "install",
    version: 1,
    post: true,
    params: {
      type: 0,
      volume_path: volumePath,
      path: filePath,
      check_codesign: true,
      force: false,
      installrunpackage: true,
      extra_values: "{}",
    },
  });
}

/** Stop a running package before in-place upgrade. DSM 7.3 returns code 4501
 *  on `upgrade` if the package is currently running; stopping first avoids it.
 *  Best-effort — log and continue if the stop call fails (the upgrade attempt
 *  will surface the real reason). */
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
    console.error(`[upgrade] could not stop ${packageId}:`, err?.message ?? err);
  }
}

/** Apply an in-place upgrade (the package was already installed). The
 *  installrunpackage flag tells DSM to start the package back up after the
 *  upgrade completes. */
async function applyUpgrade(dsm: DsmClient, taskId: string): Promise<void> {
  await dsm.call({
    api: "SYNO.Core.Package.Installation",
    method: "upgrade",
    version: 1,
    post: true,
    params: {
      task_id: taskId,
      type: 0,
      check_codesign: false,
      force: false,
      installrunpackage: true,
      extra_values: "{}",
    },
  });
}

/** Poll the installed-list until `predicate(state)` returns true, or timeout. */
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

  let after: any = null;
  let ok = false;
  let error: string | undefined;
  let taskId: string | undefined;
  let targetVersion: string | undefined;

  try {
    const info = await findInCatalog(dsm, args.name);
    if (info.version === before.version) {
      throw new Error(
        `Package "${args.name}" is already at the latest version (${before.version}); no update available.`
      );
    }
    targetVersion = info.version;
    taskId = await startDownload(dsm, info);
    await pollDownloadDone(dsm, taskId);
    // DSM 7.3 errors with code 4501 on `upgrade` when the package is running.
    // Stop it before the upgrade; installrunpackage:true restarts it after.
    await stopPackage(dsm, args.name);
    await applyUpgrade(dsm, taskId);
    after = await waitForState(
      dsm,
      args.name,
      (s) => s?.version === targetVersion
    );
    ok = after?.version === targetVersion;
    if (!ok) {
      error = `Post-state check: expected version ${targetVersion}, observed ${after?.version ?? "<not installed>"}`;
    }
  } catch (err: any) {
    error = String(err?.message ?? err);
    throw err;
  } finally {
    await recordWrite(cfg, {
      tool: "nas_package_update",
      args: { ...args, task_id: taskId, target_version: targetVersion },
      before,
      after,
      ok,
      error,
    });
  }

  return { before, after, verified: ok };
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

  let after: any = null;
  let ok = false;
  let error: string | undefined;
  let taskId: string | undefined;

  try {
    const info = await findInCatalog(dsm, args.name);

    // Surface missing dependencies up front; don't auto-install transitively.
    const deps = Array.isArray(info.deppkgs) ? info.deppkgs : [];
    const missing: string[] = [];
    for (const dep of deps) {
      const depId = typeof dep === "string" ? dep : (dep?.pkg ?? dep?.id);
      if (!depId) continue;
      const state = await listOneState(dsm, depId);
      if (!state) missing.push(depId);
    }
    if (missing.length > 0) {
      throw new Error(
        `Cannot install "${args.name}": missing dependencies (${missing.join(", ")}). Install dependencies via DSM Package Center first, or call nas_package_install for each.`
      );
    }

    taskId = await startDownload(dsm, info);
    await pollDownloadDone(dsm, taskId);
    const filename = await getDownloadedFilename(dsm, taskId);
    const volumePath = await checkInstallFeasibility(dsm, args.name);
    await applyInstall(dsm, volumePath, filename);
    after = await waitForState(dsm, args.name, (s) => s != null);
    ok = after != null;
    if (!ok) {
      error = `Post-state: package "${args.name}" not found in installed list after install.`;
    }
  } catch (err: any) {
    error = String(err?.message ?? err);
    throw err;
  } finally {
    await recordWrite(cfg, {
      tool: "nas_package_install",
      args: { ...args, task_id: taskId },
      before,
      after,
      ok,
      error,
    });
  }

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

  let after: any = null;
  let ok = false;
  let error: string | undefined;

  try {
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
      args: { ...args },
      before,
      after,
      ok,
      error,
    });
  }

  return { before, after, removed: ok };
}
