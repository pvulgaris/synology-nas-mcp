/**
 * Config parsing — the router-target edge a NAS deploy can silently hit.
 * Container Manager injects `ROUTER_USER: ${ROUTER_USER:-}` — an *empty string*,
 * not unset — when the host var is absent. optional()'s `??` would keep "" and
 * log into SRM with account="", so parseRouter must fall back to the dedicated
 * `claude-mcp` admin instead.
 *
 * Pure: drives loadConfig with a controlled env, restored after each case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

/** Run `fn` with `env` applied over process.env, restoring the prior values. */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const BASE = { DSM_BASE_URL: "https://nas.test:5001", DSM_OP_VAULT: "TestVault" };
const ROUTER = { ...BASE, ROUTER_BASE_URL: "https://router.test:8001" };

test("router: empty ROUTER_USER (compose ${ROUTER_USER:-}) falls back to claude-mcp", () => {
  withEnv({ ...ROUTER, ROUTER_USER: "" }, () => {
    assert.equal(loadConfig().router?.user, "claude-mcp");
  });
});

test("router: whitespace-only ROUTER_USER falls back to claude-mcp", () => {
  withEnv({ ...ROUTER, ROUTER_USER: "   " }, () => {
    assert.equal(loadConfig().router?.user, "claude-mcp");
  });
});

test("router: unset ROUTER_USER falls back to claude-mcp", () => {
  withEnv({ ...ROUTER, ROUTER_USER: undefined }, () => {
    assert.equal(loadConfig().router?.user, "claude-mcp");
  });
});

test("router: an explicit ROUTER_USER is honoured", () => {
  withEnv({ ...ROUTER, ROUTER_USER: "srm-admin" }, () => {
    assert.equal(loadConfig().router?.user, "srm-admin");
  });
});

test("no ROUTER_BASE_URL ⇒ router disabled (NAS-only back-compat)", () => {
  withEnv({ ...BASE, ROUTER_BASE_URL: undefined, ROUTER_USER: "" }, () => {
    assert.equal(loadConfig().router, null);
  });
});
