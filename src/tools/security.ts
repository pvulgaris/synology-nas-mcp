/**
 * Security-related read tools. All read-only; no auto-remediation.
 *
 * SYNO.Core.SecurityScan.Operation/Status — async Security Advisor scan
 * SYNO.Core.User                          — accounts + 2FA (DSM 7 uses 2fa_status)
 * SYNO.Core.Security.Firewall(.Rules etc) — firewall state
 * SYNO.Core.Security.AutoBlock(.Rules)    — auto-block toggle + entries
 * SYNO.Core.Security.DoS                  — DoS protection toggle
 * SYNO.Core.Security.DSM                  — HTTPS/TLS (v4 in DSM 7)
 * SYNO.Core.Terminal                      — SSH + Telnet (v3 in DSM 7)
 * SYNO.Core.FileServ.SMB                  — SMB protocol settings (v3 in DSM 7)
 * SYNO.Core.Upgrade.Setting               — DSM auto-update (v3 in DSM 7)
 * SYNO.Core.User.PasswordPolicy           — password policy (v1)
 */

import type { DsmClient } from "../dsm.js";

const SCAN_POLL_MS = 2000;
const SCAN_TIMEOUT_MS = 5 * 60 * 1000;

// Severity bucket normalization: DSM emits danger/risk/warning/outOfDate/info/safe.
// Collapse to the four buckets the audit composition consumes.
const SEVERITY_BUCKET: Record<string, string> = {
  danger: "critical",
  risk: "critical",
  warning: "warning",
  outofdate: "warning",
  info: "info",
  safe: "safe",
};

export async function nasSecurityAdvisorScan(dsm: DsmClient) {
  // Kick off a scan. Already-running scans return non-success; ignore and poll.
  await dsm
    .call({
      api: "SYNO.Core.SecurityScan.Operation",
      method: "start",
      version: 1,
      params: { items: "ALL" },
      post: true,
    })
    .catch(() => null);

  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await dsm
      .call({
        api: "SYNO.Core.SecurityScan.Status",
        method: "system_get",
        version: 1,
      })
      .catch(() => null);
    if ((status?.sysProgress ?? 0) >= 100) break;
    await new Promise((r) => setTimeout(r, SCAN_POLL_MS));
  }

  const results = await dsm.call({
    api: "SYNO.Core.SecurityScan.Status",
    method: "rule_get",
    version: 1,
    params: { items: "ALL" },
  });

  const grouped: Record<string, any[]> = {
    critical: [],
    warning: [],
    info: [],
    safe: [],
  };
  const items = (results?.items ?? {}) as Record<string, any>;
  for (const [ruleId, item] of Object.entries(items)) {
    const raw = (item.severity ?? "info").toLowerCase();
    const bucket = SEVERITY_BUCKET[raw] ?? "info";
    grouped[bucket].push({
      id: item.id ?? ruleId,
      title: item.strId,
      category: item.category,
      severity: item.severity ?? "info",
      status: item.status,
    });
  }
  return { findings: grouped };
}

// DSM 7 returns additional[] fields flat on each user object (not nested).
// `expired` is a string: "normal" or "now"; pass through and let the consumer
// interpret rather than guessing at boolean semantics.
export async function nasUsersList(dsm: DsmClient) {
  const data = await dsm.call({
    api: "SYNO.Core.User",
    method: "list",
    version: 1,
    params: {
      type: "local",
      offset: 0,
      limit: -1,
      sort_by: "name",
      sort_direction: "ASC",
      additional:
        '["email","description","expired","cannot_chg_passwd","passwd_never_expire","password_last_change","groups","2fa_status"]',
    },
  });
  return {
    users: (data?.users ?? []).map((u: any) => ({
      name: u.name,
      description: u.description,
      email: u.email,
      expired: u.expired,
      otp_enabled: u["2fa_status"],
      cannot_change_password: u.cannot_chg_passwd,
      password_never_expire: u.passwd_never_expire,
      password_last_change: u.password_last_change,
      groups: u.groups,
    })),
  };
}

export async function nasFirewallList(dsm: DsmClient) {
  const [firewall, rules, adapters, geoip, autoblock, autoblockRules, dos] =
    await Promise.all([
      dsm
        .call({ api: "SYNO.Core.Security.Firewall", method: "get", version: 1 })
        .catch(() => null),
      dsm
        .call({ api: "SYNO.Core.Security.Firewall.Rules", method: "list", version: 1 })
        .catch(() => ({ rules: [] })),
      dsm
        .call({ api: "SYNO.Core.Security.Firewall.Adapter", method: "list", version: 1 })
        .catch(() => ({ adapters: [] })),
      dsm
        .call({ api: "SYNO.Core.Security.Firewall.Geoip", method: "get", version: 1 })
        .catch(() => null),
      dsm
        .call({ api: "SYNO.Core.Security.AutoBlock", method: "get", version: 1 })
        .catch(() => null),
      dsm
        .call({ api: "SYNO.Core.Security.AutoBlock.Rules", method: "list", version: 1 })
        .catch(() => ({ rules: [] })),
      dsm
        .call({ api: "SYNO.Core.Security.DoS", method: "get", version: 1 })
        .catch(() => null),
    ]);
  return {
    firewall_enabled: firewall?.enable_firewall ?? null,
    firewall_profile: firewall?.profile ?? null,
    rules: rules?.rules ?? [],
    adapters: adapters?.adapters ?? [],
    geoip,
    auto_block: autoblock,
    auto_block_rules: autoblockRules?.rules ?? [],
    dos_protection: dos,
  };
}

// `SYNO.Core.Security.DSM` v4 returns CSRF / CSP / session-timeout fields but
// NOT the HTTPS-enforce or min-TLS toggles — those live on a different API
// (SYNO.Core.Web.DSM, SYNO.Core.Service.PortForwarding, or similar) that
// requires JSON request format which our DsmClient doesn't support yet. Skip
// for now; covered separately in the open Phase 4 list.
export async function nasDsmSecuritySettings(dsm: DsmClient) {
  const [security, terminal, smb, autoUpdate, passwd] = await Promise.all([
    dsm.call({ api: "SYNO.Core.Security.DSM", method: "get", version: 4 }).catch(() => null),
    dsm.call({ api: "SYNO.Core.Terminal", method: "get", version: 3 }).catch(() => null),
    dsm.call({ api: "SYNO.Core.FileServ.SMB", method: "get", version: 3 }).catch(() => null),
    dsm.call({ api: "SYNO.Core.Upgrade.Setting", method: "get", version: 3 }).catch(() => null),
    dsm.call({ api: "SYNO.Core.User.PasswordPolicy", method: "get", version: 1 }).catch(() => null),
  ]);
  return {
    web_hardening: {
      csrf_protection: security?.enable_csrf_protection ?? null,
      csp_header: security?.csp_header_option ?? null,
      ip_check: security?.skip_ip_checking === false ? true : security?.skip_ip_checking === true ? false : null,
      session_timeout_min: security?.timeout ?? null,
    },
    ssh_enabled: terminal?.enable_ssh ?? null,
    ssh_port: terminal?.ssh_port,
    telnet_enabled: terminal?.enable_telnet ?? null,
    smb: {
      enabled: smb?.enable_samba ?? null,
      min_protocol: smb?.smb_min_protocol ?? null,
      max_protocol: smb?.smb_max_protocol ?? null,
      encrypt_transport: smb?.smb_encrypt_transport ?? null,
      enable_smb1: typeof smb?.smb_min_protocol === "number" ? smb.smb_min_protocol <= 1 : null,
      workgroup: smb?.workgroup,
    },
    auto_update: {
      type: autoUpdate?.autoupdate_type ?? null,
      schedule: autoUpdate?.schedule,
      smart_nano: autoUpdate?.smart_nano_enabled,
    },
    password_policy: passwd,
  };
}
