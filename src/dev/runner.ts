#!/usr/bin/env node
/**
 * Dev runner — exercise the DSM client directly against a live NAS without
 * touching the MCP transport or the container. Use this to iterate on the
 * package-upgrade flow against nas.local:5001 over Tailscale.
 *
 *   DSM_BASE_URL=https://nas.local:5001 \
 *   DSM_OP_VAULT=your-1password-vault DSM_OP_ITEM='Synology DSM' \
 *   DEBUG_DSM_RESPONSES=1 \
 *   npx tsx src/dev/runner.ts <subcommand> [args]
 *
 * Subcommands:
 *   list                      — installed packages, condensed
 *   pending                   — packages with updates available
 *   info <name>               — nas_package_info tool output (name/publisher/etc.)
 *   catalog <name>            — full catalog entry (link/md5/size)
 *   update <name>             — run the production upgrade flow end-to-end
 *   raw <api> <method> [k=v…] — one-shot DSM call (GET); add `--post` to POST.
 *                               version defaults to 1; pass `--version=N`.
 *   deploy [--tar=<path>] [--project=<name>]
 *                             — upload tar → import image → rebuild Compose
 *                               project → poll /health. Defaults: tar at
 *                               ~/Downloads/synology-nas-mcp-<version>.tar,
 *                               project 'synology-nas-mcp'.
 *
 * The point of `raw` is iteration: try `Installation.upgrade` with different
 * param combos until 4501 goes away, without rebuilding anything.
 */
import { loadConfig } from "../config.js";
import { DsmClient } from "../dsm.js";
import {
  nasPackagesList,
  nasPackagesCheckUpdates,
  nasPackageInfo,
  nasPackageUpdate,
} from "../tools/packages.js";
import { deploy } from "./deploy.js";

function parseRawArgs(args: string[]): {
  api: string;
  method: string;
  version: number;
  post: boolean;
  params: Record<string, string>;
} {
  const [api, method, ...rest] = args;
  if (!api || !method) {
    throw new Error("raw: usage: raw <api> <method> [--post] [--version=N] [k=v…]");
  }
  let post = false;
  let version = 1;
  const params: Record<string, string> = {};
  for (const tok of rest) {
    if (tok === "--post") {
      post = true;
      continue;
    }
    const v = tok.match(/^--version=(\d+)$/);
    if (v) {
      version = parseInt(v[1], 10);
      continue;
    }
    const eq = tok.indexOf("=");
    if (eq < 0) throw new Error(`raw: unparsable token "${tok}" — expected k=v`);
    params[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return { api, method, version, post, params };
}

async function main() {
  const cfg = loadConfig();
  if (cfg.tlsSkipVerify) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const dsm = new DsmClient(cfg);
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    console.error("usage: runner <list|pending|catalog|update|raw> …");
    process.exit(2);
  }

  switch (cmd) {
    case "list": {
      const r = await nasPackagesList(dsm);
      for (const p of r.packages) {
        console.log(
          `${p.id.padEnd(28)} ${String(p.version).padEnd(20)} ${p.status} ${p.additional.is_system ? "[system]" : ""}`
        );
      }
      break;
    }
    case "pending": {
      const r = await nasPackagesCheckUpdates(dsm);
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "info": {
      const name = rest[0];
      if (!name) throw new Error("info: usage: info <name>");
      const out = await nasPackageInfo(dsm, { name });
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    case "catalog": {
      const name = rest[0];
      if (!name) throw new Error("catalog: usage: catalog <name>");
      const data = await dsm.call<any>({
        api: "SYNO.Core.Package.Server",
        method: "list",
        version: 2,
        params: { tab: "all" },
      });
      const pkg = (data?.packages ?? []).find(
        (p: any) => p.id === name || p.name === name
      );
      console.log(JSON.stringify(pkg ?? { not_found: name }, null, 2));
      break;
    }
    case "update": {
      const name = rest[0];
      if (!name) throw new Error("update: usage: update <name>");
      const out = await nasPackageUpdate(cfg, dsm, { name });
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    case "raw": {
      const parsed = parseRawArgs(rest);
      const out = await dsm.call<any>(parsed);
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    case "deploy": {
      // Parse --tar=… and --project=… flags; defaults derived from package.json.
      let tar: string | undefined;
      let project: string | undefined;
      for (const tok of rest) {
        const t = tok.match(/^--tar=(.+)$/);
        if (t) { tar = t[1]; continue; }
        const p = tok.match(/^--project=(.+)$/);
        if (p) { project = p[1]; continue; }
        throw new Error(`deploy: unknown flag "${tok}"`);
      }
      if (!tar) {
        // Default: ~/Downloads/synology-nas-mcp-<version>.tar
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const home = process.env.HOME!;
        const pkg = JSON.parse(
          await readFile(
            join(new URL(import.meta.url).pathname, "..", "..", "..", "package.json"),
            "utf8"
          )
        );
        tar = join(home, "Downloads", `synology-nas-mcp-${pkg.version}.tar`);
      }
      const out = await deploy(cfg, { tar, project });
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    case "json": {
      // Like `raw` but send the body as JSON (Content-Type: application/json).
      // DSM's SYNO.API.Info says some Package APIs use requestFormat: "JSON".
      const parsed = parseRawArgs(rest);
      const cfg2 = (dsm as any).cfg as { dsmBaseUrl: string };
      await (dsm as any).ensureSession();
      const sid = (dsm as any).sid as string;
      const url = `${cfg2.dsmBaseUrl}/webapi/entry.cgi`;
      // Coerce param values: "true"/"false"/numbers/{}/[] → JSON-typed.
      const coerced: Record<string, unknown> = {
        api: parsed.api,
        version: parsed.version,
        method: parsed.method,
        _sid: sid,
      };
      for (const [k, v] of Object.entries(parsed.params)) {
        if (v === "true") coerced[k] = true;
        else if (v === "false") coerced[k] = false;
        else if (/^-?\d+$/.test(v)) coerced[k] = parseInt(v, 10);
        else if (v.startsWith("{") || v.startsWith("[")) {
          try { coerced[k] = JSON.parse(v); } catch { coerced[k] = v; }
        } else coerced[k] = v;
      }
      console.error("[dsm-json] →", JSON.stringify(coerced));
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(coerced),
      });
      const text = await res.text();
      console.error(`[dsm-json] HTTP ${res.status}`);
      console.log(text);
      break;
    }
    default:
      console.error(`unknown subcommand: ${cmd}. Try one of: list, pending, info, catalog, update, raw, json, deploy.`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error("[fatal]", err?.message ?? err);
  process.exit(1);
});
