/**
 * Unit coverage for the SRM router reads. SRM exposes no package-update API
 * (SYNO.Core.Package.Server 103s live), so routerPackagesCheckUpdates only probes
 * the catalog to distinguish a genuine absence from a real outage and returns a
 * note — these tests pin that discrimination (and the "unexpected catalog" guard).
 * The OS-check mapping is pinned to the shape verified live on SRM 1.3.1 (2026-06-26).
 *
 * Pure + deterministic: the router routes all I/O through `client.call`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DsmError, type DsmClient, type DsmCallOptions } from "../dsm.js";
import { routerPackagesCheckUpdates, routerSrmOsCheckUpdate } from "./router.js";

function fakeClient(handlers: Record<string, (params: Record<string, unknown>) => unknown>): DsmClient {
  const call = async (opts: DsmCallOptions): Promise<unknown> => {
    const key = `${opts.api}.${opts.method}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected DSM call: ${key}`);
    return h((opts.params ?? {}) as Record<string, unknown>);
  };
  return { call } as unknown as DsmClient;
}

/** The error type DsmClient.callOnce throws — what the router's catch
 *  discriminates on (only 102/103/104 degrade; everything else propagates). */
function dsmErr(code: number, api = "SYNO.Core.Package.Server", method = "list"): DsmError {
  return new DsmError(api, method, code, undefined, `${api}.${method} failed (code ${code})`);
}

// ── routerPackagesCheckUpdates ──────────────────────────────────────────────

test("router packages: an unexpected catalog response is flagged for HAR, not diffed", async () => {
  // A hypothetical future SRM that DOES answer Package.Server. We deliberately keep
  // no guessed diff, so this must surface a "verify with a HAR" note — never emit
  // pending updates from an unverified shape.
  const router = fakeClient({
    "SYNO.Core.Package.Server.list": () => ({ packages: [{ id: "VPNPlusServer", version: "1.4.5-1234" }] }),
  });

  const { pending, note } = await routerPackagesCheckUpdates(router);

  assert.deepEqual(pending, []);
  assert.match(note, /unverified|HAR/i);
});

test("router packages: missing Package.Server API degrades to an honest note, not an error", async () => {
  const router = fakeClient({
    // Live SRM 1.3.1 behaviour: the catalog method doesn't exist (code 103).
    "SYNO.Core.Package.Server.list": () => { throw dsmErr(103); },
    "SYNO.Core.Package.list": () => { throw new Error("should not be reached"); },
  });

  const { pending, note } = await routerPackagesCheckUpdates(router);

  assert.deepEqual(pending, []);
  assert.match(note ?? "", /no package-update API/i);
});

test("router packages: a real outage/auth error propagates, not masked as 'no API'", async () => {
  // 402 (lapsed admin grant) must NOT be swallowed into the benign no-API note —
  // it's a real failure the user needs to see (digest then marks the source ok:false).
  const authLapsed = fakeClient({
    "SYNO.Core.Package.Server.list": () => { throw dsmErr(402); },
    "SYNO.Core.Package.list": () => { throw new Error("unreached"); },
  });
  await assert.rejects(routerPackagesCheckUpdates(authLapsed), /402/);

  // A non-DsmError (network failure / timeout abort) likewise propagates.
  const unreachable = fakeClient({
    "SYNO.Core.Package.Server.list": () => { throw new Error("fetch failed"); },
    "SYNO.Core.Package.list": () => { throw new Error("unreached"); },
  });
  await assert.rejects(routerPackagesCheckUpdates(unreachable), /fetch failed/);
});

// ── routerSrmOsCheckUpdate ──────────────────────────────────────────────────

test("router OS: maps the live SRM update shape (1.3.1 → 1.3.2)", async () => {
  const router = fakeClient({
    "SYNO.Core.System.info": () => ({ firmware_ver: "SRM 1.3.1-9346 Update 13" }),
    "SYNO.Core.Upgrade.Server.check": () => ({ available: true, version: "SRM 1.3.2-9366" }),
  });

  const o = await routerSrmOsCheckUpdate(router);

  assert.equal(o.available, true);
  assert.equal(o.current_version, "SRM 1.3.1-9346 Update 13");
  assert.equal(o.available_version, "SRM 1.3.2-9366");
});

test("router OS: System.info failure degrades current_version to null, still reports availability", async () => {
  const router = fakeClient({
    // The .catch(() => null) in routerSrmOsCheckUpdate must absorb this.
    "SYNO.Core.System.info": () => { throw new Error("code 104"); },
    "SYNO.Core.Upgrade.Server.check": () => ({ available: false }),
  });

  const o = await routerSrmOsCheckUpdate(router);

  assert.equal(o.current_version, null);
  assert.equal(o.available, false);
});
