/**
 * Shared output shapes for the update-availability tools and the digest, plus the
 * OS-update response mapper. Dependency-free (no imports) so callers can use these
 * without pulling in a `tools/` module's graph — and so `tools/router.ts` and
 * `tools/updates.ts` can both use `mapOsUpdate` without importing each other.
 */

/** Read-only "is an OS update available" result. Shared by DSM and SRM — both
 *  map their upgrade-check response into this shape. */
export interface OsUpdateStatus {
  current_version: string | null;
  available: boolean;
  available_version: string | null;
  reboot_required: boolean | null;
  changelog_url: string | null;
  /** DSM/SRM's own status enum, passed through for debugging. */
  raw_status: string | null;
}

/** One pending update — an OS bump or a package bump, on the NAS or the router. */
export interface ComponentUpdate {
  device: "nas" | "router";
  component: "os" | "package";
  /** "DSM"/"SRM" for os; package id for package. */
  id: string;
  name: string;
  installed_version: string | null;
  available_version: string;
  changelog?: string;
  changelog_url?: string;
}

/** Per-source outcome. `ok:false` is a real failure (device down, API error).
 *  `note` carries a non-error explanation (e.g. router not configured). */
export interface SourceResult {
  source: "nas_os" | "nas_packages" | "router_os" | "router_packages";
  ok: boolean;
  error?: string;
  note?: string;
  updates: ComponentUpdate[];
}

/** Aggregated result across all four sources — the `synology_update_digest`
 *  tool's output. `pending` is the flattened union of everything available. */
export interface UpdateDigest {
  generated_at: string;
  total_pending: number;
  any_errors: boolean;
  sources: SourceResult[];
  pending: ComponentUpdate[];
}

/** Map a DSM/SRM `SYNO.Core.Upgrade.Server check` response into OsUpdateStatus.
 *  Defensive: DSM nests under `data.update`; some versions add `data.current`.
 *  Shared by the DSM and SRM OS-check tools — lives here (dependency-free) so
 *  neither tool module has to import the other. */
/** DSM/SRM encode booleans inconsistently across endpoints (true, the string
 *  "true", or numeric 1/0), so coerce defensively. Returns null for absent or
 *  unrecognised values — lets reboot_required stay tri-state (unknown vs explicit
 *  false) and avoids Boolean("false") === true. */
function coerceBool(v: unknown): boolean | null {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  return null;
}

export function mapOsUpdate(check: any, currentVersion: string | null): OsUpdateStatus {
  const u = check?.update ?? check ?? {};
  const availableFlag = coerceBool(u.available) === true;
  const availVer: string | null =
    (typeof u.version === "string" && u.version) ||
    (typeof u.available_version === "string" && u.available_version) ||
    null;
  // Treat "available" as true only when DSM also names a version — avoids the
  // "checking"/transient false-positive that erodes trust (we bias to silence).
  const available = availableFlag && !!availVer;
  const reboot_required = coerceBool(u.reboot ?? u.restart);
  return {
    current_version: currentVersion ?? (typeof check?.current?.version === "string" ? check.current.version : null),
    available,
    available_version: available ? availVer : null,
    reboot_required,
    changelog_url:
      (typeof u.url === "string" && u.url) || (typeof u.link === "string" && u.link) || null,
    raw_status: typeof u.status === "string" ? u.status : null,
  };
}
