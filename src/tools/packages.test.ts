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
import { nasPackageInstall } from "./packages.js";

// Force the audit write to a throwaway local file (never the remote POST).
delete process.env.MCP_AUDIT_URL;
const cfg = {
  auditLogDir: mkdtempSync(path.join(os.tmpdir(), "synmcp-test-")),
} as unknown as Config;

const CATALOG = [
  { id: "TextEditor", name: "Text Editor", version: "1.0.0-1000", link: "http://x/te.spk", md5: "t", size: 1000, source: "syno", beta: false, install_type: "", install_on_cold_storage: false },
  { id: "UniversalViewer", name: "Universal Viewer", version: "1.4.0-0712", link: "http://x/uv.spk", md5: "u", size: 16069888, source: "syno", beta: false, install_type: "", install_on_cold_storage: true },
  { id: "SynologyDrive", name: "Synology Drive Server", version: "4.0.3-27892", link: "http://x/sd.spk", md5: "s", size: 37974657, source: "syno", beta: false, install_type: "", install_on_cold_storage: true },
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
    return { id, name: c.name, version: c.version, additional: { status: "running", install_type: "", startable: true } };
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
