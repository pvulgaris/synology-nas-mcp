/**
 * Synology router (SRM) reads. SRM speaks the same SYNO.* Web API as DSM, but with
 * differences confirmed live against SRM 1.3.1 (RT6600ax):
 *   - login is at auth.cgi with SYNO.API.Auth v3 (DSM uses entry.cgi / v6) — handled
 *     by the router SynoClient's authPath/authVersion (see config.ts).
 *   - package/upgrade reads are admin-gated, so the router account must be a
 *     *dedicated SRM admin* (Control Panel → User → Edit → "Grant administrator
 *     privilege"; a Normal user gets code 402 at login).
 * The router client is constructed read-only (see SynoClient).
 *
 *   router_srm_os_check_update  — is an SRM OS update available (read-only). This is
 *     the only registered SRM tool. routerPackagesCheckUpdates below is an internal
 *     helper for synology_update_digest, NOT a standalone tool — SRM exposes no
 *     package-update API, so there's nothing worth surfacing on its own.
 *
 * Detection only — no SRM writes (the router login uses a dedicated SRM admin
 * credential; a bricked router would also drop this very connection).
 */

import { DsmError, type SynoClient } from "../dsm.js";
import { type OsUpdateStatus } from "../types.js";
import { osCheckUpdate } from "./os-check.js";

/** Router add-on package update check — an internal helper for synology_update_digest,
 *  not a registered tool (there's nothing to detect on its own; see below).
 *
 *  CAVEAT (confirmed live on SRM 1.3.1): SRM does NOT expose DSM's package-update
 *  catalog — `SYNO.Core.Package.Server` has no callable read method (code 103), and
 *  `SYNO.Core.Package.list` carries no online version to diff against. There is
 *  nothing to detect, so we probe the catalog endpoint only to distinguish a genuine
 *  absence (102/103/104) from a real outage/auth failure, and return an honest
 *  `note`. Router *OS* updates ARE detected (see routerSrmOsCheckUpdate).
 *
 *  We deliberately keep NO catalog-vs-installed diff for a hypothetical future SRM
 *  that adds the API: it doesn't exist on any shipping firmware, its shape would be
 *  unverifiable today, and it'd need a HAR capture to wire correctly regardless. If
 *  such a firmware ever answers, we flag it loudly instead of emitting a guess. */
export async function routerPackagesCheckUpdates(
  router: SynoClient
): Promise<{ pending: never[]; note: string }> {
  try {
    await router.call({
      api: "SYNO.Core.Package.Server",
      method: "list",
      version: 1,
      params: { tab: "update" },
    });
  } catch (err) {
    // 102/103/104 = the API / method / version genuinely doesn't exist (live-
    // confirmed 103 on SRM 1.3.1). Anything else — outage, lapsed admin grant (402),
    // TOTP reuse (404), timeout/abort — is a real failure: re-throw so the digest
    // marks router_packages ok:false instead of masking the outage as a benign note.
    if (!(err instanceof DsmError) || ![102, 103, 104].includes(err.code)) {
      throw err;
    }
    // Surface the actual code so a version mismatch (104 — API present at another
    // version) is distinguishable from a genuine absence (102/103).
    return {
      pending: [],
      note:
        `SRM exposes no package-update API (SYNO.Core.Package.Server returned code ` +
        `${err.code}; 102/103 = absent, 104 = version mismatch — confirmed 103 on ` +
        `SRM 1.3.1). Router OS updates are covered by router_srm_os_check_update.`,
    };
  }
  // Unexpected: a future SRM firmware answered. We don't trust a guessed diff —
  // surface that it needs verification rather than emitting bogus pending updates.
  return {
    pending: [],
    note:
      "SRM unexpectedly returned a package catalog — its shape is unverified; capture " +
      "a HAR and wire detection before trusting router package results.",
  };
}

/** SRM OS-update check. Confirmed live on SRM 1.3.1: the router reuses
 *  `SYNO.Core.Upgrade.Server check` v1 and returns DSM's flat `{available, version}`
 *  shape, so the shared osCheckUpdate handles it unchanged. The one difference from
 *  DSM is the current-version read: `SYNO.Core.System info` at **v1** (v3 is DSM-only
 *  and 104s on SRM). */
export function routerSrmOsCheckUpdate(router: SynoClient): Promise<OsUpdateStatus> {
  return osCheckUpdate(router, 1);
}
