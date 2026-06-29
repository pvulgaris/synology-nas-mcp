/**
 * Unit coverage for the OS-update mapper and the cross-device digest — the
 * branches a live NAS+router can't exercise on demand (you can't manufacture a
 * pending update, a device-down error, or a not-configured router against real
 * hardware). The happy-path digest fake mirrors the shape verified live on
 * 2026-06-26 (SRM 1.3.1 → 1.3.2 detected, NAS clean), so it doubles as a
 * regression lock on that result.
 *
 * Pure + deterministic: every function routes its DSM/SRM I/O through
 * `client.call`, so one stubbed method per client covers the whole flow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DsmError, type SynoClient, type DsmCallOptions } from "../dsm.js";
import { mapOsUpdate } from "../types.js";
import { synologyUpdateDigest } from "./updates.js";

/** Build a fake client from `api.method` → handler. A handler that throws makes
 *  `call` reject (simulating a DSM error / device down); a missing key throws an
 *  explicit "unexpected" so a drifting call shape fails loud, not silently. */
function fakeClient(handlers: Record<string, (params: Record<string, unknown>) => unknown>): SynoClient {
  const call = async (opts: DsmCallOptions): Promise<unknown> => {
    const key = `${opts.api}.${opts.method}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected DSM call: ${key}`);
    return h((opts.params ?? {}) as Record<string, unknown>);
  };
  return { call } as unknown as SynoClient;
}

/** A DsmError as SynoClient.callOnce throws it — the type the router's catch keys
 *  on (only 102/103/104 degrade to a note; outages/auth errors propagate). */
function dsmErr(code: number, api = "SYNO.Core.Package.Server", method = "list"): DsmError {
  return new DsmError(api, method, code, undefined, `${api}.${method} failed (code ${code})`);
}

// ── mapOsUpdate ─────────────────────────────────────────────────────────────

test("mapOsUpdate: DSM nests the result under `update`", () => {
  const o = mapOsUpdate(
    { update: { available: true, version: "DSM 7.2.2-72806 Update 1", reboot: true } },
    "DSM 7.2.1-69057 Update 5"
  );
  assert.equal(o.available, true);
  assert.equal(o.available_version, "DSM 7.2.2-72806 Update 1");
  assert.equal(o.current_version, "DSM 7.2.1-69057 Update 5");
  assert.equal(o.reboot_required, true);
});

test("mapOsUpdate: SRM returns the same flat {available,version} shape (live-confirmed)", () => {
  // Verified against SRM 1.3.1 on 2026-06-26 — the anticipated {type,version}-only
  // shape never materialised; SRM reuses DSM's flat shape, so no special-casing.
  const o = mapOsUpdate(
    { available: true, version: "SRM 1.3.2-9366" },
    "SRM 1.3.1-9346 Update 13"
  );
  assert.equal(o.available, true);
  assert.equal(o.available_version, "SRM 1.3.2-9366");
  assert.equal(o.current_version, "SRM 1.3.1-9346 Update 13");
});

test("mapOsUpdate: available flag but no named version ⇒ not available (silence guard)", () => {
  // The "checking…"/transient case. Biasing to silence avoids crying wolf.
  const o = mapOsUpdate({ available: true }, "DSM 7.2.2-72806");
  assert.equal(o.available, false);
  assert.equal(o.available_version, null);
  // ...but the parse-miss is surfaced — this warning is the standing-in observability
  // for a live HAR: an availability flag with no version means a shape change.
  assert.match(o.warning ?? "", /no version parsed/);
});

test("mapOsUpdate: not-available response ⇒ false, null version", () => {
  const o = mapOsUpdate({ available: false, version: "" }, "DSM 7.2.2-72806");
  assert.equal(o.available, false);
  assert.equal(o.available_version, null);
  assert.equal(o.warning, undefined); // genuinely up to date — no anomaly to flag
});

test("mapOsUpdate: null/empty check degrades, keeps current from the arg", () => {
  for (const check of [null, undefined, {}]) {
    const o = mapOsUpdate(check, "SRM 1.3.1-9346 Update 13");
    assert.equal(o.available, false);
    assert.equal(o.available_version, null);
    assert.equal(o.current_version, "SRM 1.3.1-9346 Update 13");
  }
});

test("mapOsUpdate: falls back to check.current.version and parses changelog url", () => {
  const o = mapOsUpdate(
    { update: { available: true, version: "x-1", url: "https://example.test/notes" }, current: { version: "x-0" } },
    null
  );
  assert.equal(o.current_version, "x-0");
  assert.equal(o.changelog_url, "https://example.test/notes");
  assert.equal(o.reboot_required, null); // neither reboot nor restart present
});

test("mapOsUpdate: accepts numeric-truthy available when a version is named", () => {
  // Some SYNO endpoints encode booleans as 1/0; with a concrete version the
  // silence guard must not reject a real update.
  const o = mapOsUpdate({ available: 1, version: "DSM 7.3-99999" }, "DSM 7.2.2-72806");
  assert.equal(o.available, true);
  assert.equal(o.available_version, "DSM 7.3-99999");
});

test("mapOsUpdate: stringy reboot 'false' is false, not Boolean('false')===true", () => {
  const o = mapOsUpdate(
    { update: { available: true, version: "v-2", reboot: "false" } },
    "v-1"
  );
  assert.equal(o.reboot_required, false);
});

// ── synologyUpdateDigest ─────────────────────────────────────────────────────────

/** NAS fake with nothing pending: clean DSM OS check, installed == catalog. */
function cleanNas(): SynoClient {
  return fakeClient({
    "SYNO.Core.System.info": () => ({ firmware_ver: "DSM 7.2.2-72806" }),
    "SYNO.Core.Upgrade.Server.check": () => ({ available: false }),
    "SYNO.Core.Package.list": () => ({ packages: [{ id: "HyperBackup", name: "Hyper Backup", version: "3.0.0-2000" }] }),
    "SYNO.Core.Package.Server.list": () => ({ packages: [{ id: "HyperBackup", name: "Hyper Backup", version: "3.0.0-2000" }] }),
  });
}

test("digest: four sources assemble; a real SRM OS update lands in pending", { timeout: 3000 }, async () => {
  const router = fakeClient({
    "SYNO.Core.System.info": () => ({ firmware_ver: "SRM 1.3.1-9346 Update 13" }),
    "SYNO.Core.Upgrade.Server.check": () => ({ available: true, version: "SRM 1.3.2-9366" }),
    // SRM has no package-update API → this 103s live; graceful degrade to a note.
    "SYNO.Core.Package.Server.list": () => { throw dsmErr(103); },
    "SYNO.Core.Package.list": () => ({ packages: [] }),
  });

  const d = await synologyUpdateDigest(cleanNas(), router);

  assert.equal(d.sources.length, 4);
  assert.equal(d.any_errors, false);
  assert.equal(d.total_pending, 1);
  assert.equal(d.pending.length, 1);
  assert.deepEqual(d.pending[0], {
    device: "router",
    component: "os",
    id: "SRM",
    name: "SRM (router)",
    installed_version: "SRM 1.3.1-9346 Update 13",
    available_version: "SRM 1.3.2-9366",
    changelog_url: undefined,
  });
  const byName = Object.fromEntries(d.sources.map((s) => [s.source, s]));
  assert.equal(byName.router_os.ok, true);
  assert.equal(byName.router_packages.ok, true); // degraded, not errored
  // The "no package-update API" note must survive into the digest (not be dropped),
  // else router_packages reads as "all current" — false reassurance.
  assert.match(byName.router_packages.note ?? "", /no package-update API/i);
  assert.equal(byName.nas_os.ok, true);
  assert.equal(byName.nas_packages.ok, true);
});

test("digest: one device down ⇒ that source ok:false, others still report", { timeout: 3000 }, async () => {
  const router = fakeClient({
    "SYNO.Core.System.info": () => { throw new Error("router unreachable"); },
    "SYNO.Core.Upgrade.Server.check": () => { throw new Error("DSM login failed (code 404)"); },
    // A real outage (not a 103 capability gap) must surface as ok:false, not the note.
    "SYNO.Core.Package.Server.list": () => { throw new Error("router unreachable"); },
    "SYNO.Core.Package.list": () => { throw new Error("router unreachable"); },
  });

  const d = await synologyUpdateDigest(cleanNas(), router);

  assert.equal(d.any_errors, true);
  const byName = Object.fromEntries(d.sources.map((s) => [s.source, s]));
  assert.equal(byName.router_os.ok, false);
  assert.match(byName.router_os.error ?? "", /404/);
  assert.equal(byName.router_packages.ok, false); // outage propagates, not masked
  // The NAS sources are unaffected — one device down doesn't abort the rest.
  assert.equal(byName.nas_os.ok, true);
  assert.equal(byName.nas_packages.ok, true);
});

test("digest: no router configured ⇒ router sources noted, not errored", { timeout: 3000 }, async () => {
  const d = await synologyUpdateDigest(cleanNas(), null);

  assert.equal(d.sources.length, 4);
  assert.equal(d.any_errors, false);
  assert.equal(d.total_pending, 0);
  const byName = Object.fromEntries(d.sources.map((s) => [s.source, s]));
  assert.equal(byName.router_os.ok, true);
  assert.equal(byName.router_os.note, "router not configured");
  assert.equal(byName.router_packages.note, "router not configured");
});
