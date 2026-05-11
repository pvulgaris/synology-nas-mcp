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
    { name: "synology-nas-mcp", version: "0.1.5" },
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
    "HTTPS-only state, TLS minimum, SSH on/off + port, SMB min/max protocol + encryption, DSM auto-update mode, password policy. Use for the 'is my NAS configured safely?' question.",
    {},
    safeTool(() => nasDsmSecuritySettings(dsm))
  );

  server.tool(
    "nas_shares_list",
    "Shared folders incl. Time-Machine flag, encryption, quota MB, snapshot support. Note: Time-Machine *backup state* (last successful, in-progress) lives in `tmutil` on the Mac being backed up, not here.",
    {},
    safeTool(() => nasSharesList(dsm))
  );

  // ── Write tools — client surfaces to user; server logs every call ─────────

  server.tool(
    "nas_package_install",
    "[Not yet implemented in v0.1.x] Install a package. DSM 7's 6-step async install flow isn't wired up yet — calling this returns an error pointing to the DSM UI. Use Package Center directly until v0.2.",
    {
      name: z.string().describe("Package id to install"),
      version: z
        .string()
        .optional()
        .describe("Specific version; omit for latest"),
    },
    safeTool((args) => nasPackageInstall(cfg, dsm, args))
  );

  server.tool(
    "nas_package_uninstall",
    "[Not yet implemented in v0.1.x] Uninstall a package. Calling this returns an error pointing to the DSM UI. Use Package Center directly until v0.2.",
    {
      name: z.string().describe("Package id to uninstall"),
      keep_data: z
        .boolean()
        .optional()
        .describe(
          "Keep package data on disk (default true; pass false to delete)"
        ),
    },
    safeTool((args) => nasPackageUninstall(cfg, dsm, args))
  );

  server.tool(
    "nas_package_update",
    "[Not yet implemented in v0.1.x] Update a single package. Calling this returns an error pointing to the DSM UI — apply via Package Center → Update tab. Will be wired in v0.2 when the multi-step DSM install flow is ported.",
    { name: z.string().describe("Package id to update") },
    safeTool((args) => nasPackageUpdate(cfg, dsm, args))
  );

  return server;
}
