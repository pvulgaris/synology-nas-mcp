/**
 * MCP server setup. Registers all NAS tools. Reads are free to invoke; writes
 * are listed but the client (Claude Desktop / Code) is responsible for getting
 * the user's explicit `yes` before invoking them. The server enforces:
 *   - schema (zod)
 *   - hard refusals on DSM-self / kernel package writes (in tools/packages.ts)
 *   - per-write audit log (audit.ts)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import type { DsmClient } from "./dsm.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { VERSION } from "./version.js";
import { nasStatus, nasStorageHealth } from "./tools/system.js";
import {
  nasPackagesList,
  nasPackagesCheckUpdates,
  nasPackageInfo,
  nasPackageInstall,
  nasPackageUninstall,
  nasPackageUpdate,
} from "./tools/packages.js";
import {
  nasSecurityAdvisorScan,
  nasUsersList,
  nasFirewallList,
  nasDsmSecuritySettings,
} from "./tools/security.js";
import { nasSharesList } from "./tools/shares.js";
import { nasExternalAccess } from "./tools/external.js";
import { nasNotifications } from "./tools/notifications.js";
import { nasCertificates } from "./tools/certificates.js";
import { nasDataProtection } from "./tools/data_protection.js";

function jsonContent(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorContent(err: any) {
  const msg = String(err?.message ?? err);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
  };
}

function safeTool<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return jsonContent(await fn(args));
    } catch (err) {
      return errorContent(err);
    }
  };
}

export function createServer(cfg: Config, dsm: DsmClient): McpServer {
  const server = new McpServer(
    { name: "synology-nas-mcp", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  // ── Read tools — free to invoke ───────────────────────────────────────────

  server.tool(
    "nas_status",
    "DSM/system status: model, DSM version, uptime, temperature, CPU/memory load. Cheap first call to confirm the NAS is reachable and the session is alive.",
    {},
    safeTool(() => nasStatus(dsm))
  );

  server.tool(
    "nas_storage_health",
    "Volumes (status, used/free, RAID level) + drives (S.M.A.R.T. status, temp, model). Use for drive-health checks and Time-Machine quota planning.",
    {},
    safeTool(() => nasStorageHealth(dsm))
  );

  server.tool(
    "nas_packages_list",
    "All installed packages with versions, running state, and is_system flag. The is_system flag distinguishes core DSM packages from user-installable ones.",
    {},
    safeTool(() => nasPackagesList(dsm))
  );

  server.tool(
    "nas_packages_check_updates",
    "Packages with pending updates available from the official Synology repo. DSM itself is intentionally excluded — managing DSM updates is out of scope; apply those via DSM UI.",
    {},
    safeTool(() => nasPackagesCheckUpdates(dsm))
  );

  server.tool(
    "nas_package_info",
    "Metadata for a single package (publisher, description, changelog, dependencies, size).",
    { name: z.string().describe("Package id, e.g. 'HyperBackup'") },
    safeTool((args) => nasPackageInfo(dsm, args))
  );

  server.tool(
    "nas_security_advisor_scan",
    "Run DSM Security Advisor (synchronous from the caller's POV; polls until the async scan finishes). Returns findings grouped by severity (critical/warning/info/safe).",
    {},
    safeTool(() => nasSecurityAdvisorScan(dsm))
  );

  server.tool(
    "nas_users_list",
    "DSM user accounts: name, uid, 2FA on/off, expired flag, password-change restrictions, description, email.",
    {},
    safeTool(() => nasUsersList(dsm))
  );

  server.tool(
    "nas_firewall_list",
    "Firewall profiles, auto-block (failed-login lockout), and DoS protection settings.",
    {},
    safeTool(() => nasFirewallList(dsm))
  );

  server.tool(
    "nas_dsm_security_settings",
    "DSM hardening posture: web (HTTPS-redirect, HSTS, ports, CSRF/CSP, session timeout), per-service TLS profile, SSH/Telnet on-off, SMB protocol min/max + encryption, NFS on-off, DSM auto-update mode, password policy, Active Insight telemetry toggle. Use for the 'is my NAS configured safely?' question.",
    {},
    safeTool(() => nasDsmSecuritySettings(dsm))
  );

  server.tool(
    "nas_shares_list",
    "Shared folders with encryption, quota (used/total MB), recycle-bin, snapshot support, BTRFS COW flag. DSM 7's share API does not expose an explicit Time Machine flag — identify TM shares by name. Time-Machine *backup state* (last successful, in-progress) lives in `tmutil` on the Mac being backed up, not here.",
    {},
    safeTool(() => nasSharesList(dsm))
  );

  server.tool(
    "nas_external_access",
    "What's reachable from outside the LAN: QuickConnect (master toggle + relay flag + alias), DDNS records, Application Portal apps (per-app HTTPS-redirect), Reverse Proxy entries, UPnP-driven port-forwarding rules. Empty everywhere = NAS not internet-facing.",
    {},
    safeTool(() => nasExternalAccess(dsm))
  );

  server.tool(
    "nas_notifications",
    "Notification posture: SMTP mail config (server, port, SSL, verify-cert, sender, recipient count). Empty recipient list = SMTP wired but no human hears alerts.",
    {},
    safeTool(() => nasNotifications(dsm))
  );

  server.tool(
    "nas_certificates",
    "DSM certificate inventory with derived `days_until_expiry` per cert. Flag any cert with days_until_expiry < 30.",
    {},
    safeTool(() => nasCertificates(dsm))
  );

  server.tool(
    "nas_data_protection",
    "Backup + snapshot posture: Hyper Backup tasks (destination, encryption flag, last status) + Snapshot Replication state. Reports `installed: false` per service if the corresponding package isn't installed — that itself is a finding for ransomware mitigation.",
    {},
    safeTool(() => nasDataProtection(dsm))
  );

  // ── Write tools — client surfaces to user; server logs every call ─────────

  server.tool(
    "nas_package_install",
    "Install a package from the official Synology repo. Runs the DSM UI's single-call install sequence (feasibility_check → get_queue → Installation.check → Installation.install with operation=\"install\"). Refuses DSM/kernel. Refuses if already installed (use nas_package_update). Mutating — confirm with user before calling. Verifies post-state by polling Package.list for the version flip.",
    {
      name: z.string().describe("Package id to install (e.g. 'TextEditor')"),
      version: z
        .string()
        .optional()
        .describe("Specific version; omit for latest"),
    },
    safeTool((args) => nasPackageInstall(cfg, dsm, args))
  );

  server.tool(
    "nas_package_uninstall",
    "Uninstall an installed package. Data linked to the package may be removed by DSM — confirm with user before calling. Refuses DSM/kernel. Verifies post-state.",
    { name: z.string().describe("Package id to uninstall") },
    safeTool((args) => nasPackageUninstall(cfg, dsm, args))
  );

  server.tool(
    "nas_package_update",
    "Update an installed package to the latest version. Runs the DSM UI's actual upgrade sequence (feasibility_check → get_queue → Installation.check → Installation.upgrade with operation=\"upgrade\"). Refuses DSM/kernel. Refuses if package is already current. Mutating — confirm with user before calling. Verifies post-state by polling Package.list for the version flip.",
    { name: z.string().describe("Package id to update") },
    safeTool((args) => nasPackageUpdate(cfg, dsm, args))
  );

  return server;
}
