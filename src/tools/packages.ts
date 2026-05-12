/**
 * Package Center tools. Reads: list, check_updates, info.
 * Writes: install, uninstall, update — all single-call against DSM 7.
 *
 * History note: an earlier (v0.2.0–0.2.5) iteration ported the multi-step
 * download-and-install orchestration from the `N4S4/synology-api` Python lib
 * (catalog lookup → start download → poll status → Download.check →
 * Installation.check → Installation.install/upgrade). That kept hitting code
 * 4501 from the final upgrade call. Found `aldarondo/claude-synology`, which
 * does the whole thing as a *single* call:
 *
 *   GET  SYNO.Core.Package.Installation v1 method=upgrade id=<pkg>
 *   POST SYNO.Core.Package.Installation v1 method=install  pkgname=<pkg>
 *        volume_path=<vol>
 *
 * DSM does the download/install/upgrade internally when given a single
 * command. The multi-step lib API is only needed when installing from a
 * caller-supplied URL.
 *
 * APIs used:
 *   SYNO.Core.Package          v2  — list installed
 *   SYNO.Core.Package.Server   v2  — catalog
 *   SYNO.Core.Package.Installation   v1  — install / upgrade
 *   SYNO.Core.Package.Uninstallation v1  — uninstall
 */

import type { Config } from "../config.js";
import type { DsmClient } from "../dsm.js";
import { recordWrite } from "../audit.js";

const HARD_REFUSE_NAMES = new Set(["DSM", "kernel"]);

const POSTOP_VERIFY_TIMEOUT_MS = 5 * 60 * 1000; // installs/upgrades can take a couple minutes
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
}

/** Read the catalog entry for a package id (or display name). Used only to
 *  preflight: confirm the package is in the repo and capture the target
 *  version for post-state verification. */
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
  return { id: pkg.id, name: pkg.name, version: pkg.version };
}

/** Resolve a volume to install onto when Package Center's default-volume
 *  setting is "Always ask me". Synology returns volume_path: "" in that case,
 *  along with a volume_list; we pick the one with the most free space. */
async function resolveInstallVolume(
  dsm: DsmClient,
  packageId: string
): Promise<string> {
  const result = await dsm.call<any>({
    api: "SYNO.Core.Package.Installation",
    method: "check",
    version: 1,
    post: true,
    params: { id: packageId, install_type: "" },
  });
  const direct = result?.volume_path;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const list = Array.isArray(result?.volume_list) ? result.volume_list : [];
  const pick = list
    .slice()
    .sort(
      (a: any, b: any) => Number(b?.size_free ?? 0) - Number(a?.size_free ?? 0)
    )[0];
  const mount = pick?.mount_point;
  if (typeof mount !== "string" || mount.length === 0) {
    throw new Error(
      `Could not resolve install volume: ${JSON.stringify(result)}`
    );
  }
  return mount;
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
  let targetVersion: string | undefined;

  try {
    const info = await findInCatalog(dsm, args.name);
    if (info.version === before.version) {
      throw new Error(
        `Package "${args.name}" is already at the latest version (${before.version}); no update available.`
      );
    }
    targetVersion = info.version;

    // Single-call upgrade. DSM handles the download + install internally.
    await dsm.call({
      api: "SYNO.Core.Package.Installation",
      method: "upgrade",
      version: 1,
      params: { id: args.name },
    });

    after = await waitForState(
      dsm,
      args.name,
      (s) => s?.version === targetVersion
    );
    ok = after?.version === targetVersion;
    if (!ok) {
      error = `Post-state check: expected version ${targetVersion}, observed ${after?.version ?? "<not installed>"}.`;
    }
  } catch (err: any) {
    error = String(err?.message ?? err);
    throw err;
  } finally {
    await recordWrite(cfg, {
      tool: "nas_package_update",
      args: { ...args, target_version: targetVersion },
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
  let volumePath: string | undefined;

  try {
    await findInCatalog(dsm, args.name); // surfaces a clearer error if not in repo
    volumePath = await resolveInstallVolume(dsm, args.name);

    // Single-call install. `pkgname` (not `name` or `id`) per DSM's accepted
    // schema for this method — confirmed against aldarondo/claude-synology.
    await dsm.call({
      api: "SYNO.Core.Package.Installation",
      method: "install",
      version: 1,
      post: true,
      params: { pkgname: args.name, volume_path: volumePath },
    });

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
      args: { ...args, volume_path: volumePath },
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
