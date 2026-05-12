/**
 * Smoke-test runner: invoke each fixed read tool against a real DSM and pretty-
 * print the result. Used by `npm run verify` after `npm run deploy` to confirm
 * Phase 3 fixes return populated payloads.
 *
 * Usage: source dev/source-creds.sh && DSM_BASE_URL=https://nas.local:5001 \
 *        npx tsx src/dev/verify-tools.ts [tool-name]
 *
 * No tool name → run all six. Tool name → run just that one.
 */
import { loadConfig } from "../config.js";
import { DsmClient } from "../dsm.js";
import { nasStatus, nasStorageHealth } from "../tools/system.js";
import { nasSharesList } from "../tools/shares.js";
import {
  nasPackagesList,
  nasPackagesCheckUpdates,
} from "../tools/packages.js";
import {
  nasUsersList,
  nasFirewallList,
  nasDsmSecuritySettings,
  nasSecurityAdvisorScan,
} from "../tools/security.js";
import { nasExternalAccess } from "../tools/external.js";
import { nasNotifications } from "../tools/notifications.js";
import { nasCertificates } from "../tools/certificates.js";
import { nasDataProtection } from "../tools/data_protection.js";

const SUITE: Record<string, (dsm: DsmClient) => Promise<unknown>> = {
  nas_status: nasStatus,
  nas_storage_health: nasStorageHealth,
  nas_shares_list: nasSharesList,
  nas_packages_list: nasPackagesList,
  nas_packages_check_updates: nasPackagesCheckUpdates,
  nas_users_list: nasUsersList,
  nas_firewall_list: nasFirewallList,
  nas_dsm_security_settings: nasDsmSecuritySettings,
  nas_security_advisor_scan: nasSecurityAdvisorScan,
  nas_external_access: nasExternalAccess,
  nas_notifications: nasNotifications,
  nas_certificates: nasCertificates,
  nas_data_protection: nasDataProtection,
};

async function main() {
  const cfg = loadConfig();
  if (!cfg.tlsRejectUnauthorized) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const dsm = new DsmClient(cfg);

  const filter = process.argv[2];
  const names = filter ? [filter] : Object.keys(SUITE);

  for (const name of names) {
    const fn = SUITE[name];
    if (!fn) {
      console.error(`unknown tool: ${name}`);
      process.exit(2);
    }
    console.error(`\n=== ${name} ===`);
    try {
      const out = await fn(dsm);
      console.log(JSON.stringify(out, null, 2));
    } catch (err) {
      console.error(`FAIL: ${err instanceof Error ? err.message : err}`);
    }
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
