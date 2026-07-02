/**
 * Regression tests for the fresh-install flow. Drives nasPackageInstall against
 * a fake DsmClient (every tool routes all DSM I/O through dsm.call, so one
 * stubbed method covers the whole flow) — no live NAS, deterministic, fast.
 *
 * These pin the bug fixed alongside them: the old single-call install only
 * DOWNLOADED the .spk and never committed, so the package never appeared in
 * Package.list and the handler spun to the 15-min timeout. The fake never marks
 * a package installed until it sees the install-from-path commit, so the old
 * code hangs here — hence the tight per-test timeout (new code finishes in ms).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import type { Config } from "../config.js";
import type { DsmClient, DsmCallOptions } from "../dsm.js";
import {
  nasPackageInstall,
  nasPackageUninstall,
  nasPackageInfo,
  nasPackagesCheckUpdates,
} from "./packages.js";

// Force the audit write to a throwaway local file (never the remote POST).
delete process.env.MCP_AUDIT_URL;
const cfg = {
  auditLogDir: mkdtempSync(path.join(os.tmpdir(), "synmcp-test-")),
} as unknown as Config;

// Field names mirror the real HAR-verified SYNO.Core.Package.Server.list
// shape: display name is `dname` (not `name`), publisher is `maintainer`
// (not `publisher`), description is `desc` (not `description`), and
// dependencies are `deppkgs` (not `depend_packages`).
const CATALOG = [
  { id: "TextEditor", dname: "Text Editor", version: "1.0.0-1000", link: "http://x/te.spk", md5: "t", size: 1000, source: "syno", beta: false, install_type: "", install_on_cold_storage: false },
  { id: "UniversalViewer", dname: "Universal Viewer", version: "1.4.0-0712", link: "http://x/uv.spk", md5: "u", size: 16069888, source: "syno", beta: false, install_type: "", install_on_cold_storage: true },
  { id: "SynologyDrive", dname: "Synology Drive Server", version: "4.0.3-27892", link: "http://x/sd.spk", md5: "s", size: 37974657, source: "syno", beta: false, install_type: "", install_on_cold_storage: true },
  {
    id: "Tailscale",
    dname: "Tailscale",
    version: "1.58.2-700058002",
    link: "http://x/ts.spk",
    md5: "z",
    size: 26220613,
    source: "syno",
    beta: false,
    install_type: "",
    install_on_cold_storage: false,
    maintainer: "Tailscale, Inc.",
    desc: "Connect all your devices using WireGuard, without the hassle.",
    changelog: "",
    deppkgs: null,
  },
];

interface Recorded {
  api: string;
  method: string;
  params: Record<string, unknown>;
}

/** Stateful fake DSM: `installed` starts empty and only gains a package when
 *  the install-from-path commit (`installrunpackage`) is seen for it. */
function makeFake(queue: Array<{ pkg: string }>) {
  const installed = new Set<string>();
  const calls: Recorded[] = [];
  let pendingId = "";
  const pkgObj = (id: string) => {
    const c = CATALOG.find((x) => x.id === id)!;
    return { id, name: c.dname, version: c.version, additional: { status: "running", install_type: "", startable: true } };
  };
  const call = async (opts: DsmCallOptions): Promise<unknown> => {
    const params = (opts.params ?? {}) as Record<string, unknown>;
    calls.push({ api: opts.api, method: opts.method, params });
    switch (`${opts.api}.${opts.method}`) {
      case "SYNO.Core.Package.list":
        return { packages: [...installed].map(pkgObj) };
      case "SYNO.Core.Package.Server.list":
        return { packages: CATALOG };
      case "SYNO.Core.Package.feasibility_check":
        return {};
      case "SYNO.Core.Package.Installation.get_queue":
        return { queue, broken_pkgs: [], conflicted_pkgs: [], non_exist_pkgs: [], paused_pkgs: [] };
      case "SYNO.Core.Package.Installation.check":
        return { volume_list: [{ mount_point: "/volume1" }] };
      case "SYNO.Core.Package.Installation.install":
        if (params.installrunpackage !== undefined) {
          if (pendingId) installed.add(pendingId); // the commit
          return { worker_message: [] };
        }
        pendingId = JSON.parse(String(params.name)); // the download
        return { taskid: `@SYNOPKG_DOWNLOAD_${pendingId}` };
      case "SYNO.Core.Package.Installation.status":
        return { finished: true, success: true, status: "installing" };
      case "SYNO.Core.Package.Installation.Download.check":
        return { filename: `/volume1/@tmp/synopkg/download/${pendingId}` };
      case "SYNO.Core.Package.Installation.delete":
        return {};
      default:
        throw new Error(`unexpected DSM call: ${opts.api}.${opts.method}`);
    }
  };
  return { dsm: { call } as unknown as DsmClient, calls, installed };
}

const commits = (calls: Recorded[]) =>
  calls.filter(
    (c) =>
      c.api === "SYNO.Core.Package.Installation" &&
      c.method === "install" &&
      c.params.installrunpackage !== undefined
  );

test("issues an install-from-path commit, not just a download", { timeout: 3000 }, async () => {
  const { dsm, calls } = makeFake([{ pkg: "TextEditor" }]);
  const res = (await nasPackageInstall(cfg, dsm, { name: "TextEditor" })) as any;
  assert.equal(res.verified, true);
  assert.equal(res.after.version, "1.0.0-1000");
  // The regression: old code never issued this second call, so the package
  // never landed and the poll hung. Require exactly one commit with the flag.
  assert.equal(commits(calls).length, 1);
  assert.equal(commits(calls)[0].params.installrunpackage, true);
});

test("gates on dependencies: returns the plan and mutates nothing", { timeout: 3000 }, async () => {
  const { dsm, calls, installed } = makeFake([{ pkg: "UniversalViewer" }, { pkg: "SynologyDrive" }]);
  const res = (await nasPackageInstall(cfg, dsm, { name: "SynologyDrive" })) as any;
  assert.equal(res.status, "needs_dependency_confirmation");
  assert.deepEqual(res.will_also_install, [{ id: "UniversalViewer", version: "1.4.0-0712" }]);
  assert.equal(installed.size, 0);
  assert.equal(commits(calls).length, 0);
});

test("accept_dependencies: installs the resolved queue, dependency first", { timeout: 3000 }, async () => {
  const { dsm, calls, installed } = makeFake([{ pkg: "UniversalViewer" }, { pkg: "SynologyDrive" }]);
  const res = (await nasPackageInstall(cfg, dsm, { name: "SynologyDrive", accept_dependencies: true })) as any;
  assert.equal(res.verified, true);
  assert.equal(res.after.id, "SynologyDrive");
  assert.deepEqual(res.dependencies_installed, [{ id: "UniversalViewer", version: "1.4.0-0712" }]);
  assert.deepEqual([...installed].sort(), ["SynologyDrive", "UniversalViewer"]);
  const order = commits(calls).map((c) => String(JSON.parse(String(c.params.path))).split("/").pop());
  assert.deepEqual(order, ["UniversalViewer", "SynologyDrive"]);
});

// ── Uninstall: data-decision gate ──────────────────────────────────────────

/** Stateful fake for the uninstall flow: one installed package that disappears
 *  once `Uninstallation.uninstall` is seen. `Package.list` returns the raw
 *  `additional.is_uninstall_pages` (omitted when false, as DSM does) — the same
 *  single read nasPackageUninstall now uses for both state and the data flag. */
function makeUninstallFake(pkg: { id: string; version: string; status: string; isUninstallPages: boolean }) {
  let present = true;
  let status = pkg.status;
  const calls: Recorded[] = [];
  const call = async (opts: DsmCallOptions): Promise<unknown> => {
    const params = (opts.params ?? {}) as Record<string, unknown>;
    calls.push({ api: opts.api, method: opts.method, params });
    switch (`${opts.api}.${opts.method}`) {
      case "SYNO.Core.Package.list": {
        if (!present) return { packages: [] };
        return {
          packages: [
            {
              id: pkg.id,
              name: pkg.id,
              version: pkg.version,
              additional: { status, install_type: "", startable: true, ...(pkg.isUninstallPages ? { is_uninstall_pages: true } : {}) },
            },
          ],
        };
      }
      case "SYNO.Core.Package.Control.stop":
        status = "stopped";
        return {};
      case "SYNO.Core.Package.Uninstallation.uninstall":
        present = false;
        return {};
      default:
        throw new Error(`unexpected DSM call: ${opts.api}.${opts.method}`);
    }
  };
  return { dsm: { call } as unknown as DsmClient, calls, isPresent: () => present };
}

const uninstallCalls = (calls: Recorded[]) =>
  calls.filter((c) => c.api === "SYNO.Core.Package.Uninstallation" && c.method === "uninstall");

test("data-bearing package: gates with needs_data_confirmation, mutates nothing", { timeout: 3000 }, async () => {
  const { dsm, calls, isPresent } = makeUninstallFake({ id: "ActiveBackup", version: "3.2.0-25053", status: "running", isUninstallPages: true });
  const res = (await nasPackageUninstall(cfg, dsm, { name: "ActiveBackup" })) as any;
  assert.equal(res.status, "needs_data_confirmation");
  assert.equal(uninstallCalls(calls).length, 0);
  assert.equal(isPresent(), true);
});

test("keep_data:false is refused (routed to the UI), mutates nothing", { timeout: 3000 }, async () => {
  const { dsm, calls, isPresent } = makeUninstallFake({ id: "ActiveBackup", version: "3.2.0-25053", status: "running", isUninstallPages: true });
  await assert.rejects(nasPackageUninstall(cfg, dsm, { name: "ActiveBackup", keep_data: false }), /Package Center|not supported/i);
  assert.equal(uninstallCalls(calls).length, 0);
  assert.equal(isPresent(), true);
});

test("keep_data:true: proceeds with the data-preserving uninstall", { timeout: 3000 }, async () => {
  const { dsm, calls, isPresent } = makeUninstallFake({ id: "ActiveBackup", version: "3.2.0-25053", status: "running", isUninstallPages: true });
  const res = (await nasPackageUninstall(cfg, dsm, { name: "ActiveBackup", keep_data: true })) as any;
  assert.equal(res.removed, true);
  assert.equal(res.had_data_dialog, true);
  assert.equal(res.stopped, true);
  assert.equal(isPresent(), false);
  // Exactly one uninstall, targeting this package, with NO delete key
  // (extra_values) — i.e. the data-preserving call.
  const uc = uninstallCalls(calls);
  assert.equal(uc.length, 1);
  assert.equal(uc[0].params.id, "ActiveBackup");
  assert.equal(uc[0].params.extra_values, undefined);
});

test("no-data package: uninstalls directly without gating", { timeout: 3000 }, async () => {
  const { dsm, isPresent } = makeUninstallFake({ id: "UniversalViewer", version: "1.4.0-0712", status: "stopped", isUninstallPages: false });
  const res = (await nasPackageUninstall(cfg, dsm, { name: "UniversalViewer" })) as any;
  assert.equal(res.removed, true);
  assert.equal(res.had_data_dialog, false);
  assert.equal(isPresent(), false);
});

// ── Catalog field mapping (regression: DSM names these dname/maintainer/desc/
// deppkgs, not name/publisher/description/depend_packages — a live smoke test
// against production caught nas_package_info silently dropping these fields) ─

function makeCatalogFake() {
  const call = async (opts: DsmCallOptions): Promise<unknown> => {
    if (opts.api === "SYNO.Core.Package.Server" && opts.method === "list") {
      return { packages: CATALOG };
    }
    if (opts.api === "SYNO.Core.Package" && opts.method === "list") {
      return { packages: [{ id: "Tailscale", version: "1.58.2-700058000" }] };
    }
    throw new Error(`unexpected DSM call: ${opts.api}.${opts.method}`);
  };
  return { call } as unknown as DsmClient;
}

test("nas_package_info: surfaces name/publisher/description/dependencies from the real dname/maintainer/desc/deppkgs fields", async () => {
  const dsm = makeCatalogFake();
  const res = (await nasPackageInfo(dsm, { name: "Tailscale" })) as any;
  assert.equal(res.name, "Tailscale");
  assert.equal(res.publisher, "Tailscale, Inc.");
  assert.equal(res.description, "Connect all your devices using WireGuard, without the hassle.");
  assert.equal(res.dependencies, null);
});

test("nas_package_info: matches by display name (dname), not just id", async () => {
  const dsm = makeCatalogFake();
  const res = (await nasPackageInfo(dsm, { name: "Universal Viewer" })) as any;
  assert.equal(res.id, "UniversalViewer");
});

test("nas_packages_check_updates: pending entries carry the real display name", async () => {
  const dsm = makeCatalogFake();
  const res = await nasPackagesCheckUpdates(dsm);
  assert.deepEqual(res.pending, [
    { id: "Tailscale", name: "Tailscale", installed_version: "1.58.2-700058000", available_version: "1.58.2-700058002", changelog: "", beta: false },
  ]);
});
