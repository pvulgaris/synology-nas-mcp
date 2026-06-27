/**
 * Shared OS-update check for DSM and SRM. Both answer `SYNO.Core.Upgrade.Server
 * check` v1 with the same flat `{available, version}` shape (confirmed live on
 * DSM 7 and SRM 1.3.1), so the orchestration is identical — read the current
 * version from `SYNO.Core.System info`, ask the upgrade server what's available,
 * and fold both into OsUpdateStatus via the shared mapper.
 *
 * The ONE device-specific difference is the System.info API version: DSM serves
 * it at v3, SRM only at v1 (v3 104s on the router). That's the single parameter;
 * the thin nasDsmOsCheckUpdate / routerSrmOsCheckUpdate wrappers each bind it.
 *
 * Lives in its own module (not updates.ts) because updates.ts imports router.ts
 * for the digest — a shared helper there would close an updates↔router import
 * cycle. System.info is read defensively (.catch → null) so a missing current
 * version degrades to null rather than failing the whole check.
 */

import type { DsmClient } from "../dsm.js";
import { mapOsUpdate, type OsUpdateStatus } from "../types.js";

export async function osCheckUpdate(
  client: DsmClient,
  systemInfoVersion: number
): Promise<OsUpdateStatus> {
  const [info, check] = await Promise.all([
    client
      .call<any>({ api: "SYNO.Core.System", method: "info", version: systemInfoVersion })
      .catch(() => null),
    client.call<any>({ api: "SYNO.Core.Upgrade.Server", method: "check", version: 1 }),
  ]);
  return mapOsUpdate(check, info?.firmware_ver ?? null);
}
