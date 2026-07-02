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
import type { SynoClient } from "./dsm.js";
import { serverInstructions } from "./instructions.js";
import { VERSION } from "./version.js";
import { nasStatus, nasStorageHealth } from "./tools/system.js";
import {
  nasPackagesList,
  nasPackagesCheckUpdates,
  nasPackageInfo,
  nasPackageInstall,
  nasPackageUninstall,
  nasPackageUpdate,
  nasPackageControl,
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
import { nasDsmOsCheckUpdate, synologyUpdateDigest } from "./tools/updates.js";
import { routerSrmOsCheckUpdate } from "./tools/router.js";

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

export function createServer(
  cfg: Config,
  dsm: SynoClient,
  router: SynoClient | null
): McpServer {
  const server = new McpServer(
    { name: "synology-mcp", version: VERSION },
    { instructions: serverInstructions(router !== null) }
  );

  // ── Read tools — free to invoke ───────────────────────────────────────────

  server.tool(
    "nas_status",
    "DSM system status: model, version, uptime, temperature, CPU/memory load.",
    {},
    safeTool(() => nasStatus(dsm))
  );

  server.tool(
    "nas_storage_health",
    "Volumes (status, used/free, RAID level) and drives (S.M.A.R.T., temp, model).",
    {},
    safeTool(() => nasStorageHealth(dsm))
  );

  server.tool(
    "nas_packages_list",
    "Installed packages with versions, running state, and is_system flag.",
    {},
    safeTool(() => nasPackagesList(dsm))
  );

  server.tool(
    "nas_packages_check_updates",
    "Packages with pending updates from the Synology repo (excludes DSM self-update).",
    {},
    safeTool(() => nasPackagesCheckUpdates(dsm))
  );

  server.tool(
    "nas_dsm_os_check_update",
    "Whether a DSM OS update is available (read-only — does not download or apply it).",
    {},
    safeTool(() => nasDsmOsCheckUpdate(dsm))
  );

  server.tool(
    "synology_update_digest",
    "Aggregated pending updates across DSM OS, NAS packages, router OS, and router packages — one structured result. This is the Active-Insight-style cross-device update summary.",
    {},
    safeTool(() => synologyUpdateDigest(dsm, router))
  );

  // Router (SRM) reads — only registered when a router target is configured, so
  // tools/list stays honest about what's actually reachable. (SRM exposes no
  // package-update API, so there's no router-packages tool; router package state
  // is folded into synology_update_digest as an honest note instead.)
  if (router) {
    server.tool(
      "router_srm_os_check_update",
      "Whether an SRM router OS update is available (read-only).",
      {},
      safeTool(() => routerSrmOsCheckUpdate(router))
    );
  }

  server.tool(
    "nas_package_info",
    "Metadata for one package: publisher, description, changelog, dependencies, size.",
    { name: z.string().describe("Package id, e.g. 'HyperBackup'") },
    safeTool((args) => nasPackageInfo(dsm, args))
  );

  server.tool(
    "nas_security_advisor_scan",
    "Run DSM Security Advisor; returns a per-status check count plus the failing rules (passing/skipped rules are summarized in the count, not listed). Polls until the async scan finishes.",
    {},
    safeTool(() => nasSecurityAdvisorScan(dsm))
  );

  server.tool(
    "nas_users_list",
    "DSM user accounts: name, uid, 2FA state, expired flag, email.",
    {},
    safeTool(() => nasUsersList(dsm))
  );

  server.tool(
    "nas_firewall_list",
    "Firewall profiles, auto-block (failed-login lockout), and per-adapter DoS protection.",
    {},
    safeTool(() => nasFirewallList(dsm))
  );

  server.tool(
    "nas_dsm_security_settings",
    "DSM hardening posture: web/TLS, SSH/Telnet, SMB, NFS, auto-update, password policy, telemetry.",
    {},
    safeTool(() => nasDsmSecuritySettings(dsm))
  );

  server.tool(
    "nas_shares_list",
    "Shared folders with encryption, quota (used/total MB), recycle-bin, snapshot support, BTRFS COW flag.",
    {},
    safeTool(() => nasSharesList(dsm))
  );

  server.tool(
    "nas_external_access",
    "External-facing posture: QuickConnect, DDNS, App Portal, reverse proxy, port forwarding.",
    {},
    safeTool(() => nasExternalAccess(dsm))
  );

  server.tool(
    "nas_notifications",
    "SMTP notification config: server, port, SSL, verify-cert, sender, recipient count.",
    {},
    safeTool(() => nasNotifications(dsm))
  );

  server.tool(
    "nas_certificates",
    "DSM certificates with derived `days_until_expiry` per cert.",
    {},
    safeTool(() => nasCertificates(dsm))
  );

  // ── Write tools — client surfaces to user; server logs every call ─────────

  server.tool(
    "nas_package_install",
    "Install a package from the Synology repo. Mutating — confirm with user. Refuses DSM/kernel and already-installed packages. If the package has dependencies, returns status:'needs_dependency_confirmation' listing them; re-call with accept_dependencies:true to install the whole set. Verifies post-state.",
    {
      name: z.string().describe("Package id to install (e.g. 'TextEditor')"),
      version: z
        .string()
        .optional()
        .describe("Specific version; omit for latest"),
      accept_dependencies: z
        .boolean()
        .optional()
        .describe(
          "Acknowledge installing the dependencies DSM resolves for this package (mirrors Package Center's confirmation dialog). Without it, a package with dependencies returns the plan instead of installing."
        ),
    },
    safeTool((args) => nasPackageInstall(cfg, dsm, args))
  );

  server.tool(
    "nas_package_uninstall",
    "Uninstall a package, PRESERVING its data. Mutating — confirm with user. Refuses DSM/kernel. If the package stores data, returns status:'needs_data_confirmation'; re-call with keep_data:true to proceed (data kept). Data DELETION is package-specific and not supported here — route it to the DSM UI. Verifies post-state.",
    {
      name: z.string().describe("Package id to uninstall"),
      keep_data: z
        .boolean()
        .optional()
        .describe(
          "Acknowledge that the uninstall preserves the package's data and proceed (mirrors Package Center leaving the 'delete data' box unchecked). false is rejected with a pointer to the DSM UI, since data deletion isn't supported via the MCP."
        ),
    },
    safeTool((args) => nasPackageUninstall(cfg, dsm, args))
  );

  server.tool(
    "nas_package_update",
    "Update a package to the latest version. Mutating — confirm with user. Refuses DSM/kernel and already-current packages. Verifies post-state.",
    { name: z.string().describe("Package id to update") },
    safeTool((args) => nasPackageUpdate(cfg, dsm, args))
  );

  server.tool(
    "nas_package_control",
    "Start/stop/restart a package. Mutating — confirm with user. Idempotent. Tolerates DSM's mid-execution connection drops; verifies via status poll.",
    {
      name: z.string().describe("Package id (e.g. 'PlexMediaServer')"),
      action: z
        .enum(["start", "stop", "restart"])
        .describe("Lifecycle action to apply"),
    },
    safeTool((args) => nasPackageControl(cfg, dsm, args))
  );

  return server;
}
