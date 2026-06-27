/**
 * Smoke-test runner: invoke each fixed read tool against a real DSM and pretty-
 * print the result. Used by `npm run verify` after `npm run deploy` to confirm
 * Phase 3 fixes return populated payloads.
 *
 * Usage: source dev/source-creds.sh && DSM_BASE_URL=https://nas.local:5001 \
 *        npx tsx src/dev/verify-tools.ts [tool-name]
 *
 * No tool name → run the whole suite. Tool name → run just that one.
 */
import { loadConfig } from "../config.js";
import { DsmClient, makeRouterClient } from "../dsm.js";
import { nasStatus, nasStorageHealth } from "../tools/system.js";
import { nasDsmOsCheckUpdate, synologyUpdateDigest } from "../tools/updates.js";
import { routerSrmOsCheckUpdate } from "../tools/router.js";
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
  nas_dsm_os_check_update: nasDsmOsCheckUpdate,
};

// Tools that need the router client too. Router tools no-op gracefully when no
// router is configured so the suite still passes on a NAS-only setup.
const ROUTER_AWARE: Record<
  string,
  (dsm: DsmClient, router: DsmClient | null) => Promise<unknown>
> = {
  synology_update_digest: (dsm, router) => synologyUpdateDigest(dsm, router),
  router_srm_os_check_update: (_dsm, router) =>
    router
      ? routerSrmOsCheckUpdate(router)
      : Promise.resolve({ note: "router not configured" }),
};

// Per-tool predicates that catch "tool returned successfully but the field is
// undefined / false / [] for every entry" — the bug shape we hit repeatedly
// before this harness existed (nas_users_list otp_enabled, nas_shares_list
// encryption, nas_packages_list is_system / status, etc.). Return null on pass,
// a short reason on fail. Run via `npm run verify -- --strict` to exit non-zero
// on any failure.
const ASSERTIONS: Record<string, (out: any) => string | null> = {
  nas_status: (o) => {
    if (typeof o.uptime_seconds !== "number") return "uptime_seconds not numeric";
    if (!o.dsm_version) return "dsm_version missing";
    if (!o.model) return "model missing";
    if (typeof o.temperature_c !== "number") return "temperature_c not numeric";
    return null;
  },
  nas_storage_health: (o) => {
    if (!Array.isArray(o.volumes) || o.volumes.length === 0) return "no volumes";
    if (!Array.isArray(o.drives) || o.drives.length === 0) return "no drives";
    if (!o.volumes.every((v: any) => typeof v.size_total === "number"))
      return "volume size_total not numeric";
    return null;
  },
  nas_shares_list: (o) => {
    if (!Array.isArray(o.shares) || o.shares.length === 0) return "no shares";
    if (!o.shares.some((s: any) => typeof s.recycle_bin === "boolean"))
      return "no share has populated recycle_bin (additional[] not unpacked?)";
    if (!o.shares.some((s: any) => typeof s.encryption === "number"))
      return "no share has populated encryption";
    return null;
  },
  nas_packages_list: (o) => {
    if (!Array.isArray(o.packages) || o.packages.length === 0) return "no packages";
    if (!o.packages.some((p: any) => p.additional?.is_system === true))
      return "no system packages detected (install_type='system' check broken)";
    if (!o.packages.some((p: any) => p.status === "running"))
      return "no running packages (additional.status not unpacked?)";
    return null;
  },
  nas_packages_check_updates: (o) => {
    if (!Array.isArray(o.pending)) return "pending not an array";
    return null;
  },
  nas_users_list: (o) => {
    if (!Array.isArray(o.users) || o.users.length === 0) return "no users";
    if (!o.users.some((u: any) => typeof u.otp_enabled === "boolean"))
      return "otp_enabled never populated (additional[] response shape wrong?)";
    if (!o.users.some((u: any) => typeof u.email === "string"))
      return "email never populated";
    return null;
  },
  nas_firewall_list: (o) => {
    if (typeof o.firewall_enabled !== "boolean") return "firewall_enabled not bool";
    if (!Array.isArray(o.profiles)) return "profiles not array";
    if (!Array.isArray(o.dos_protection)) return "dos_protection not array";
    if (!Array.isArray(o.auto_block_allow_list)) return "auto_block_allow_list not array";
    if (!Array.isArray(o.auto_block_deny_list)) return "auto_block_deny_list not array";
    return null;
  },
  nas_dsm_security_settings: (o) => {
    if (typeof o.web_hardening?.https_redirect !== "boolean")
      return "web_hardening.https_redirect not bool";
    if (typeof o.web_hardening?.hsts !== "boolean") return "web_hardening.hsts not bool";
    if (typeof o.tls_profile?.default_level !== "number")
      return "tls_profile.default_level not number";
    if (typeof o.smb?.enabled !== "boolean") return "smb.enabled not bool";
    if (typeof o.nfs?.enabled !== "boolean") return "nfs.enabled not bool";
    if (!o.password_policy?.strong_password) return "password_policy.strong_password missing";
    if (typeof o.active_insight?.monitoring_service !== "boolean")
      return "active_insight.monitoring_service not bool";
    return null;
  },
  nas_security_advisor_scan: (o) => {
    if (!o.checks || typeof o.checks.total !== "number") return "checks.total not numeric";
    if (o.checks.total === 0) return "scan returned zero rules (did it run?)";
    if (!Array.isArray(o.failures)) return "failures not an array";
    if (o.failures.length !== o.checks.failed)
      return `failures.length (${o.failures.length}) != checks.failed (${o.checks.failed})`;
    return null;
  },
  nas_external_access: (o) => {
    if (typeof o.quick_connect?.enabled !== "boolean")
      return "quick_connect.enabled not bool";
    if (!Array.isArray(o.ddns_records)) return "ddns_records not array";
    if (!Array.isArray(o.app_portal)) return "app_portal not array";
    return null;
  },
  nas_notifications: (o) => {
    if (o.mail === null) return null; // legitimate absence
    if (typeof o.mail?.enabled !== "boolean") return "mail.enabled not bool";
    if (typeof o.mail?.recipients_count !== "number")
      return "mail.recipients_count not number";
    return null;
  },
  nas_certificates: (o) => {
    if (!Array.isArray(o.certificates) || o.certificates.length === 0)
      return "no certificates";
    if (!o.certificates.every((c: any) => typeof c.days_until_expiry === "number"))
      return "days_until_expiry not numeric on all certs";
    return null;
  },
  nas_dsm_os_check_update: (o) => {
    if (typeof o.available !== "boolean") return "available not bool";
    if (o.available && !o.available_version) return "available true but no available_version";
    return null;
  },
  synology_update_digest: (o) => {
    if (!Array.isArray(o.sources) || o.sources.length !== 4) return "sources not length-4 array";
    if (!Array.isArray(o.pending)) return "pending not an array";
    if (typeof o.total_pending !== "number") return "total_pending not number";
    if (o.total_pending !== o.pending.length) return "total_pending != pending.length";
    return null;
  },
};

async function main() {
  const cfg = loadConfig();
  if (cfg.tlsSkipVerify) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const dsm = new DsmClient(cfg);
  const router = makeRouterClient(cfg);

  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const filter = args.find((a) => !a.startsWith("--"));
  const names = filter
    ? [filter]
    : [...Object.keys(SUITE), ...Object.keys(ROUTER_AWARE)];

  let failures = 0;
  for (const name of names) {
    const fn = SUITE[name]
      ? () => SUITE[name](dsm)
      : ROUTER_AWARE[name]
        ? () => ROUTER_AWARE[name](dsm, router)
        : null;
    if (!fn) {
      console.error(`unknown tool: ${name}`);
      process.exit(2);
    }
    console.error(`\n=== ${name} ===`);
    try {
      const out = await fn();
      console.log(JSON.stringify(out, null, 2));
      const check = ASSERTIONS[name];
      if (check) {
        const reason = check(out);
        if (reason) {
          console.error(`  ✗ ASSERT FAIL: ${reason}`);
          failures++;
        } else {
          console.error(`  ✓ assertions passed`);
        }
      }
    } catch (err) {
      console.error(`  ✗ FAIL: ${err instanceof Error ? err.message : err}`);
      failures++;
    }
  }
  if (strict && failures > 0) {
    console.error(`\n${failures} assertion(s) failed; exiting non-zero (--strict)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
