/**
 * Update-availability reads + the cross-device digest.
 *
 *   nas_dsm_os_check_update   — is a DSM OS update available (read-only)
 *   synology_update_digest    — pending updates across DSM OS, NAS packages,
 *                               router OS, router packages, in one result
 *
 * Detection only. Applying OS updates is out of scope (brick risk); NAS package
 * updates have the existing interactive nas_package_update.
 *
 * DSM-OS API (corroborated across py-synologydsm-api, N4S4, synoctl, synaudit):
 *   SYNO.Core.Upgrade.Server  check  v1  — GET, _sid auth, SYNCHRONOUS (no poll).
 *   Response: data.update.{available, version, reboot, restart} (+ data.current).
 * The exact field names are worth one HAR sanity-check on the live DSM; mapOsUpdate
 * parses defensively so minor shape drift degrades to `available:false` not a throw.
 */

import type { DsmClient } from "../dsm.js";
import type {
  ComponentUpdate,
  OsUpdateStatus,
  SourceResult,
  UpdateDigest,
} from "../types.js";
import { nasPackagesCheckUpdates } from "./packages.js";
import { osCheckUpdate } from "./os-check.js";
import { routerPackagesCheckUpdates, routerSrmOsCheckUpdate } from "./router.js";

/** DSM OS-update check. Reads the current version from `SYNO.Core.System info`
 *  at **v3** (DSM-only; SRM caps at v1) — the single device-specific knob the
 *  shared osCheckUpdate takes. */
export function nasDsmOsCheckUpdate(dsm: DsmClient): Promise<OsUpdateStatus> {
  return osCheckUpdate(dsm, 3);
}

// ──────────── Digest ────────────

function osToUpdates(
  device: "nas" | "router",
  id: string,
  name: string,
  s: OsUpdateStatus
): ComponentUpdate[] {
  if (!s.available || !s.available_version) return [];
  return [
    {
      device,
      component: "os",
      id,
      name,
      installed_version: s.current_version,
      available_version: s.available_version,
      changelog_url: s.changelog_url ?? undefined,
    },
  ];
}

// Accepts the loose shape from nasPackagesCheckUpdates (Record<string,unknown>[])
// and the typed router pending list alike; coerces to ComponentUpdate.
function pkgToUpdates(
  device: "nas" | "router",
  pending: ReadonlyArray<Record<string, unknown>>
): ComponentUpdate[] {
  return pending.map((p) => ({
    device,
    component: "package" as const,
    id: String(p.id),
    name: String(p.name),
    installed_version: p.installed_version == null ? null : String(p.installed_version),
    available_version: String(p.available_version),
    changelog: typeof p.changelog === "string" ? p.changelog : undefined,
  }));
}

/** Run one source's check, catching any failure into a SourceResult so a single
 *  device being down never aborts the others. `fn` may return a `note` (e.g. SRM
 *  has no package-update API) which is carried onto the SourceResult so the
 *  aggregated digest explains an empty source instead of implying "all current". */
async function runSource(
  source: SourceResult["source"],
  fn: () => Promise<{ updates: ComponentUpdate[]; note?: string }>
): Promise<SourceResult> {
  try {
    const { updates, note } = await fn();
    return note ? { source, ok: true, updates, note } : { source, ok: true, updates };
  } catch (err: any) {
    return { source, ok: false, error: String(err?.message ?? err), updates: [] };
  }
}

export async function synologyUpdateDigest(
  dsm: DsmClient,
  router: DsmClient | null
): Promise<UpdateDigest> {
  const tasks: Promise<SourceResult>[] = [
    runSource("nas_os", async () => ({
      updates: osToUpdates("nas", "DSM", "DSM", await nasDsmOsCheckUpdate(dsm)),
    })),
    runSource("nas_packages", async () => ({
      updates: pkgToUpdates("nas", (await nasPackagesCheckUpdates(dsm)).pending),
    })),
  ];
  if (router) {
    tasks.push(
      runSource("router_os", async () => ({
        updates: osToUpdates("router", "SRM", "SRM (router)", await routerSrmOsCheckUpdate(router)),
      })),
      runSource("router_packages", async () => {
        const { pending, note } = await routerPackagesCheckUpdates(router);
        return { updates: pkgToUpdates("router", pending), note };
      })
    );
  } else {
    // Route the absent-router sources through the same runSource path as the rest
    // so they can't drift from the SourceResult shape it produces. Not an error —
    // the router is intentionally absent; the note records why these are empty.
    const notConfigured = async () => ({ updates: [], note: "router not configured" });
    tasks.push(
      runSource("router_os", notConfigured),
      runSource("router_packages", notConfigured)
    );
  }
  const sources = await Promise.all(tasks);
  const pending = sources.flatMap((s) => s.updates);
  return {
    generated_at: new Date().toISOString(),
    total_pending: pending.length,
    any_errors: sources.some((s) => !s.ok),
    sources,
    pending,
  };
}
