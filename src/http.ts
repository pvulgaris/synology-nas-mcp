/**
 * Streamable HTTP transport with Bearer + Origin defenses.
 *
 *   - Bind to a specific interface (default: tailscale0's IP, resolved at startup).
 *   - Require Authorization: Bearer <mcp_bearer_token> on every request.
 *   - Reject requests whose Origin header is not in MCP_ALLOWED_ORIGINS
 *     (defense against DNS rebinding per MCP spec recommendations).
 */

import express from "express";
import os from "node:os";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { loadCredentials } from "./auth.js";
import { DsmClient } from "./dsm.js";
import { createServer } from "./server.js";

function resolveBindHost(cfg: Config): string {
  if (cfg.mcpBindHost) return cfg.mcpBindHost;
  const ifaces = os.networkInterfaces();

  // 1) Try named Tailscale interfaces.
  for (const name of ["tailscale0", "tailscale1", "ts0"]) {
    const v4 = ifaces[name]?.find((i) => i.family === "IPv4");
    if (v4) {
      console.error(`[http] binding ${name} (${v4.address})`);
      return v4.address;
    }
  }

  // 2) Synology's Tailscale package doesn't always expose the named interface
  //    inside a host-networked container. Scan for any IPv4 in Tailscale's
  //    CGNAT range (100.64.0.0/10) — that's the de-facto Tailscale signature.
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4") continue;
      const [o1, o2] = a.address.split(".").map((x) => parseInt(x, 10));
      if (o1 === 100 && o2 >= 64 && o2 <= 127) {
        console.error(
          `[http] binding ${name} (${a.address}) — matches Tailscale CGNAT range`
        );
        return a.address;
      }
    }
  }

  // 3) No Tailscale interface found. Bind 0.0.0.0 and rely on the bearer
  //    token + Tailscale ACL + (optionally) DSM firewall for safety.
  console.error(
    "[http] no Tailscale interface detected; binding 0.0.0.0. Wire-level " +
      "safety relies on the bearer token, Tailscale ACL, and DSM firewall. " +
      "Set MCP_BIND_HOST explicitly to bind to a specific IP."
  );
  return "0.0.0.0";
}

export async function startHttpDaemon(
  cfg: Config
): Promise<{ host: string; port: number }> {
  const creds = await loadCredentials(cfg);
  const expected = `Bearer ${creds.bearerToken}`;
  const host = resolveBindHost(cfg);
  const port = cfg.mcpBindPort;
  // One DsmClient across all requests — keeps the SID cache warm so we don't
  // re-login on every MCP call. The per-request McpServer wraps this.
  const dsm = new DsmClient(cfg);

  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // Health endpoint — bypasses auth so you can curl it from a tailnet host
  // without rotating the bearer token. Returns no NAS state.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, server: "synology-nas-mcp", version: "0.1.5" });
  });

  // Auth + Origin middleware applied to /mcp.
  const authMw: express.RequestHandler = (req, res, next) => {
    if (req.header("authorization") !== expected) {
      res.status(401).json({ error: "missing or invalid bearer token" });
      return;
    }
    const origin = req.header("origin") ?? "null";
    if (cfg.allowedOrigins.size > 0 && !cfg.allowedOrigins.has(origin)) {
      res
        .status(403)
        .json({ error: `origin '${origin}' not in MCP_ALLOWED_ORIGINS` });
      return;
    }
    next();
  };

  // Stateless mode: `sessionIdGenerator: undefined` tells the SDK each HTTP
  // request is fully independent. The MCP SDK's stateless pattern requires a
  // FRESH McpServer + transport per request — a shared server gets stuck in
  // a "ready" state after first use and 500s on subsequent calls. We hoist
  // the DsmClient outside (singleton with SID cache) so per-request server
  // creation is cheap.
  app.all("/mcp", authMw, async (req, res) => {
    try {
      const server = createServer(cfg, dsm);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      console.error("[/mcp]", err?.message ?? err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  await new Promise<void>((resolve) =>
    app.listen(port, host, () => resolve())
  );
  console.error(`[http] listening on http://${host}:${port}/mcp`);
  return { host, port };
}
