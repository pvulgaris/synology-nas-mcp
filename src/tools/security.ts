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

import type { SynoClient } from "../dsm.js";

const SCAN_POLL_MS = 2000;
const SCAN_TIMEOUT_MS = 5 * 60 * 1000;

// DSM emits per-rule severity as danger/risk/warning/outOfDate/info/safe.
// Normalize to the three actionable levels we report on failing rules.
const SEVERITY_BUCKET: Record<string, string> = {
  danger: "critical",
  risk: "critical",
  warning: "warning",
  outofdate: "warning",
  info: "info",
};

export async function nasSecurityAdvisorScan(dsm: SynoClient) {
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

  // Return only the actionable signal: a per-status count (proof the scan ran,
  // plus reassurance that N checks passed) and the list of failing rules. The
  // passing/skipped rules and the empty "safe" bucket were noise — an agent
  // asking "what's wrong with my NAS?" wants the failures, not a 30-rule dump.
  const items = (results?.items ?? {}) as Record<string, any>;
  const checks = { total: 0, failed: 0, passed: 0, skipped: 0 };
  const failures: Array<Record<string, unknown>> = [];
  for (const [ruleId, item] of Object.entries(items)) {
    checks.total++;
    const status = String(item.status ?? "");
    if (status === "pass") {
      checks.passed++;
      continue;
    }
    if (status === "skip") {
      checks.skipped++;
      continue;
    }
    checks.failed++;
    const raw = String(item.severity ?? "info").toLowerCase();
    failures.push({
      id: item.id ?? ruleId,
      title: item.strId,
      category: item.category,
      severity: SEVERITY_BUCKET[raw] ?? "info",
    });
  }
  return { checks, failures };
}

// DSM 7 returns additional[] fields flat on each user object (not nested).
// `expired` is a string: "normal" or "now"; pass through and let the consumer
// interpret rather than guessing at boolean semantics.
export async function nasUsersList(dsm: SynoClient) {
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

// Firewall API quirks (all DSM 7.x v=1):
// - Rules: `Firewall.Rules.list` doesn't exist. Profile is the entry point —
//   list profile names, then `get` each profile to read its rules.
// - AutoBlock entries need `offset/limit` params; missing them yields 5100
//   ("Unable to perform"), NOT "empty list".
// - PortForwarding rules use method=`load`, not `list`. Returns a bare array.
// - GeoIP `.list` returns the country catalog; per-profile blocking config
//   lives inside the profile.get response when firewall is enabled.
// - `Firewall.Adapter.list` doesn't exist on DSM 7 — use Network.Interface.
export async function nasFirewallList(dsm: SynoClient) {
  // AutoBlock.Rules.list requires both `offset/limit` AND `type=allow|deny`.
  // 5100 with no params = missing required fields; 5102 with an invalid type
  // value = enum rejection. Iterating both types captures the full allowlist
  // + denylist (lockout history isn't on this surface — that's the live
  // autoblock entries, which DSM doesn't seem to expose as a query at all).
  const [firewall, profileNames, autoblock, allowList, denyList, interfaces] =
    await Promise.all([
      dsm
        .call({ api: "SYNO.Core.Security.Firewall", method: "get", version: 1 })
        .catch(() => null),
      dsm
        .call({ api: "SYNO.Core.Security.Firewall.Profile", method: "list", version: 1 })
        .catch(() => ({ profile_names: [] as string[] })),
      dsm
        .call({ api: "SYNO.Core.Security.AutoBlock", method: "get", version: 1 })
        .catch(() => null),
      dsm
        .call({
          api: "SYNO.Core.Security.AutoBlock.Rules",
          method: "list",
          version: 1,
          params: { type: "allow", offset: 0, limit: -1 },
        })
        .catch(() => null),
      dsm
        .call({
          api: "SYNO.Core.Security.AutoBlock.Rules",
          method: "list",
          version: 1,
          params: { type: "deny", offset: 0, limit: -1 },
        })
        .catch(() => null),
      dsm
        .call<any[]>({ api: "SYNO.Core.Network.Interface", method: "list", version: 1 })
        .catch(() => [] as any[]),
    ]);

  const ifnames = (Array.isArray(interfaces) ? interfaces : [])
    .map((i: any) => i?.ifname)
    .filter((n: unknown): n is string => typeof n === "string" && n.length > 0);

  const profiles = await Promise.all(
    (profileNames?.profile_names ?? []).map(async (name: string) => {
      const detail = await dsm
        .call({
          api: "SYNO.Core.Security.Firewall.Profile",
          method: "get",
          version: 1,
          params: { name },
        })
        .catch(() => null);
      return { name, detail };
    })
  );

  // DoS protection per-adapter (form-encoded with configs JSON array).
  let dosProtection: any[] | null = null;
  if (ifnames.length > 0) {
    try {
      const configs = JSON.stringify(ifnames.map((a) => ({ adapter: a })));
      dosProtection = await dsm.call({
        api: "SYNO.Core.Security.DoS",
        method: "get",
        version: 2,
        params: { configs },
      });
    } catch {
      // surface as null
    }
  }

  return {
    firewall_enabled: firewall?.enable_firewall ?? null,
    profiles,
    auto_block: autoblock,
    auto_block_allow_list: allowList?.ip_info ?? [],
    auto_block_deny_list: denyList?.ip_info ?? [],
    dos_protection: dosProtection,
  };
}

// DSM's HTTPS-enforce + HSTS toggles live on SYNO.Core.Web.DSM v=2; the TLS
// profile lives on SYNO.Core.Web.Security.TLSProfile v=1. Both apis report
// requestFormat:"JSON" in API.Info but that describes the RESPONSE — the
// request itself is form-encoded like everything else. (Working clients
// confirmed: synaudit, NielsKrijnen, N4S4, synology-community/go-synology.)
export async function nasDsmSecuritySettings(dsm: SynoClient) {
  const [security, web, tlsProfile, terminal, smb, nfs, autoUpdate, passwd, activeInsight] = await Promise.all([
    dsm.call({ api: "SYNO.Core.Security.DSM", method: "get", version: 4 }).catch(() => null),
    dsm.call({ api: "SYNO.Core.Web.DSM", method: "get", version: 2 }).catch(() => null),
    dsm.call({ api: "SYNO.Core.Web.Security.TLSProfile", method: "get", version: 1 }).catch(() => null),
    dsm.call({ api: "SYNO.Core.Terminal", method: "get", version: 3 }).catch(() => null),
    dsm.call({ api: "SYNO.Core.FileServ.SMB", method: "get", version: 3 }).catch(() => null),
    dsm.call({ api: "SYNO.Core.FileServ.NFS", method: "get", version: 1 }).catch(() => null),
    dsm.call({ api: "SYNO.Core.Upgrade.Setting", method: "get", version: 3 }).catch(() => null),
    dsm.call({ api: "SYNO.Core.User.PasswordPolicy", method: "get", version: 1 }).catch(() => null),
    dsm.call({ api: "SYNO.ActiveInsight.Setting", method: "get", version: 1 }).catch(() => null),
  ]);
  const tlsServices = (tlsProfile?.services ?? {}) as Record<string, any>;
  return {
    web_hardening: {
      https_redirect: web?.enable_https_redirect ?? null,
      hsts: web?.enable_hsts ?? null,
      http_port: web?.http_port ?? null,
      https_port: web?.https_port ?? null,
      csrf_protection: security?.enable_csrf_protection ?? null,
      csp_header: security?.csp_header_option ?? null,
      ip_check: security?.skip_ip_checking === false ? true : security?.skip_ip_checking === true ? false : null,
      session_timeout_min: security?.timeout ?? null,
    },
    // TLS profile levels: 0=Compatible (weakest), 1=Intermediate, 2=Modern.
    // `current-level` per service overrides `default-level`.
    tls_profile: {
      default_level: tlsProfile?.["default-level"] ?? null,
      services: Object.fromEntries(
        Object.entries(tlsServices).map(([k, v]: [string, any]) => [
          k,
          { level: v?.["current-level"] ?? null, display: v?.["display-name"] },
        ])
      ),
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
    nfs: {
      enabled: nfs?.enable_nfs ?? null,
      enabled_v4: nfs?.enable_nfs_v4 ?? null,
      unix_pri: nfs?.unix_pri_enable ?? null,
    },
    auto_update: {
      type: autoUpdate?.autoupdate_type ?? null,
      schedule: autoUpdate?.schedule,
      smart_nano: autoUpdate?.smart_nano_enabled,
    },
    password_policy: passwd,
    active_insight: {
      monitoring_service: activeInsight?.monitoring_service ?? null,
    },
  };
}
