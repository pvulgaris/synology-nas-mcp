/**
 * Package Center tools. Reads: list, check_updates, info. Writes: install,
 * uninstall, update. Writes refuse to touch DSM itself or kernel-flagged
 * packages.
 *
 * SYNO.Core.Package           — list installed packages
 * SYNO.Core.Package.Server    — query available + check for updates
 * SYNO.Core.Package.Installation — install (POST)
 * SYNO.Core.Package.Uninstallation — uninstall (POST)
 */

import type { Config } from "../config.js";
import type { DsmClient } from "../dsm.js";
import { recordWrite } from "../audit.js";

const HARD_REFUSE_NAMES = new Set(["DSM", "kernel"]);
function refuseIfProtected(name: string) {
  if (HARD_REFUSE_NAMES.has(name)) {
    throw new Error(
      `Refusing to operate on package "${name}" — DSM/kernel updates can brick the host and are out of scope for this MCP. Apply via DSM UI → Control Panel → Update & Restore.`
    );
  }
}

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
  // `SYNO.Core.Package.Server.list?tab=update` returns the whole catalog of
  // packages installable on this DS — NOT actual pending updates — and the
  // response has no installed_version field, so we can't filter from one
  // endpoint. Pull the installed-package list and intersect.
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

// Write tools are intentionally stubbed in v0.1.x.
//
// DSM 7's package install/upgrade is a multi-step async flow (~6 API calls
// with polling):
//   1. Get catalog entry for url + md5 + filesize.
//   2. SYNO.Core.Package.Installation.install (operation=install, type=0,
//      url, name, checksum, filesize) → returns task_id.
//   3. Poll SYNO.Core.Package.Installation.status until finished.
//   4. SYNO.Core.Package.Installation.Download.check task_id → file_path.
//   5. SYNO.Core.Package.Installation.check id, install_type → volume_path.
//   6. SYNO.Core.Package.Installation.install (fresh) or .upgrade (in-place)
//      with task_id, type=0, volume_path, file_path, force, installrunpackage.
//
// Reference: N4S4/synology-api Python lib `core_package.py` (easy_install,
// upgrade_package, install_package). Worth porting in a focused session for
// v0.2. Until then, surface the limitation clearly so Claude can guide the
// user to the DSM UI fallback (which is the right answer for one-off
// updates anyway).
const NOT_YET_IMPLEMENTED =
  "Not yet implemented in v0.1.x. DSM 7 requires a 6-step async download/check/install flow we haven't ported. Apply via DSM Package Center UI: Package Center → Update tab → click Update on the specific package, or for new installs use Package Center → search and install. The MCP read tools (list, check_updates, info) work; we'll wire the writes for v0.2.";

interface InstallArgs {
  name: string;
  version?: string;
}

export async function nasPackageInstall(
  cfg: Config,
  _dsm: DsmClient,
  args: InstallArgs
) {
  refuseIfProtected(args.name);
  await recordWrite(cfg, {
    tool: "nas_package_install",
    args: { ...args },
    ok: false,
    error: NOT_YET_IMPLEMENTED,
  });
  throw new Error(NOT_YET_IMPLEMENTED);
}

interface UninstallArgs {
  name: string;
  keep_data?: boolean;
}

export async function nasPackageUninstall(
  cfg: Config,
  _dsm: DsmClient,
  args: UninstallArgs
) {
  refuseIfProtected(args.name);
  await recordWrite(cfg, {
    tool: "nas_package_uninstall",
    args: { ...args },
    ok: false,
    error: NOT_YET_IMPLEMENTED,
  });
  throw new Error(NOT_YET_IMPLEMENTED);
}

export async function nasPackageUpdate(
  cfg: Config,
  _dsm: DsmClient,
  args: { name: string }
) {
  refuseIfProtected(args.name);
  await recordWrite(cfg, {
    tool: "nas_package_update",
    args: { ...args },
    ok: false,
    error: NOT_YET_IMPLEMENTED,
  });
  throw new Error(NOT_YET_IMPLEMENTED);
}

// Kept for v0.2 when writes are wired: convenience to capture before/after
// state of a single package by id or display name.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function listOneState(dsm: DsmClient, name: string) {
  const all = await nasPackagesList(dsm);
  return (
    all.packages.find((p: any) => p.id === name || p.name === name) ?? null
  );
}
