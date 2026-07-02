#!/usr/bin/env node

/**
 * synology-mcp — entry point.
 *
 * Subcommands:
 *   serve         Run MCP over stdio (for `claude mcp add` / claude.json or local dev).
 *   daemon        Run MCP over Streamable HTTP on the configured interface/port.
 *   bridge        stdio→HTTP proxy for Claude Desktop (runs on the Mac).
 *
 * Required env (both modes):
 *   DSM_BASE_URL, DSM_OP_VAULT, OP_SERVICE_ACCOUNT_TOKEN
 * Required env (daemon only):
 *   MCP_BIND_HOST / MCP_BIND_PORT optional; allowlisted Origin / bearer in 1Password.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { SynoClient, makeRouterClient } from "./dsm.js";
import { startHttpDaemon } from "./http.js";

async function serveStdio() {
  const cfg = loadConfig();
  // Process-wide TLS skip for DSM's self-signed cert. We tried a per-fetch
  // undici dispatcher in v0.2.12 but it interacted badly with Node 22's
  // built-in fetch (intermittent "fetch failed" + silently-empty responses
  // on some endpoints). The blast radius of process-wide skip is bounded to
  // DSM-shaped targets: DSM at cfg.dsmBaseUrl and, when a router is configured,
  // SRM at cfg.router.baseUrl (also self-signed). If you add a non-Synology
  // outbound, route THAT call through a per-call verifying undici Agent
  // (rejectUnauthorized:true) to override the global skip.
  if (cfg.tlsSkipVerify) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const dsm = new SynoClient(cfg);
  const router = makeRouterClient(cfg);
  const server = createServer(cfg, dsm, router);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[serve] synology-mcp ready on stdio");
}

async function serveHttp() {
  const cfg = loadConfig();
  if (cfg.tlsSkipVerify) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  await startHttpDaemon(cfg);
}

/**
 * Bridge subcommand: a tiny stdio MCP server that proxies to the HTTP daemon.
 * Use this from Claude Desktop, which only accepts stdio MCP entries — the
 * bridge runs on your Mac, the daemon runs on the NAS.
 *
 * Required env (set in claude_desktop_config.json under "env"):
 *   MCP_BRIDGE_URL    e.g. http://nas.local:8765/mcp
 *   MCP_BRIDGE_TOKEN  the bearer token (the same one used by claude mcp add)
 */
async function bridge() {
  const url = process.env.MCP_BRIDGE_URL;
  const token = process.env.MCP_BRIDGE_TOKEN;
  if (!url || !token) {
    console.error(
      "[bridge] missing MCP_BRIDGE_URL or MCP_BRIDGE_TOKEN env var"
    );
    process.exit(2);
  }
  const upstream = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const downstream = new StdioServerTransport();

  // Client → server forwarding. Two safety rules:
  //   1. Swallow `notifications/*` from the client. The HTTP daemon is
  //      stateless, so client-side handshake notifications like
  //      `notifications/initialized` have nothing to update and the SDK
  //      throws 500 trying to handle them. Filtering at the bridge keeps
  //      the daemon clean and Claude Desktop happy.
  //   2. .catch any send rejection. Unhandled promise rejections kill the
  //      Node process on v22+, which manifested as "Connection closed" on
  //      every spawn after the first.
  downstream.onmessage = (msg) => {
    const m = msg as any;
    if (m && typeof m.method === "string" && m.method.startsWith("notifications/")) {
      return;
    }
    upstream.send(msg).catch((err) => {
      console.error("[bridge] upstream send failed:", err?.message ?? err);
    });
  };
  upstream.onmessage = (msg) => {
    downstream.send(msg).catch((err) => {
      console.error("[bridge] downstream send failed:", err?.message ?? err);
    });
  };
  upstream.onclose = () => downstream.close();
  downstream.onclose = () => upstream.close();
  upstream.onerror = (err) => console.error("[bridge] upstream:", err?.message ?? err);
  downstream.onerror = (err) => console.error("[bridge] downstream:", err?.message ?? err);

  await Promise.all([upstream.start(), downstream.start()]);
}

async function main() {
  const cmd = process.argv[2] ?? "serve";
  switch (cmd) {
    case "serve":
      await serveStdio();
      break;
    case "daemon":
      await serveHttp();
      break;
    case "bridge":
      await bridge();
      break;
    default:
      console.error(
        `Unknown command: ${cmd}. Use 'serve' (stdio direct), 'daemon' (HTTP), ` +
          `or 'bridge' (stdio→HTTP proxy).`
      );
      process.exit(2);
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
