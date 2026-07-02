---
name: synology
description: Manage a Synology NAS (DSM 7) — packages, security audit, shares — via the synology-mcp server. Use when the user asks about NAS status, package updates / research / installation / removal, or security posture.
---

# Synology NAS

The `mcp__synology__*` tools talk to a self-hosted MCP server running on the NAS itself. Auth (DSM SID + TOTP) and the wire bearer token are owned by the server — this skill is workflow guidance only. The DSM account (`claude-mcp`) is in the `administrators` group because DSM 7 gates the admin APIs on that membership; compensating controls (2FA, no SSH service, Tailscale ACL, bearer token) live outside this skill — don't relax them.

## When to use

- **Status + storage**: "is the NAS okay?", "drive health", "RAID state".
- **Packages**: list installed, check for updates, get info, install, update, uninstall.
- **Package research**: "what's a good package for X?", "should I install Y?" — compose with WebSearch + `nas_packages_list` (to avoid recommending what's already there).
- **Security audit**: "audit security", "is my NAS configured safely?" — compose Security Advisor scan + users + firewall + DSM settings + shares + storage + external access + notifications + certificates.

## Tool inventory

**Read tools (free to invoke):**

| Tool | Returns |
|---|---|
| `nas_status` | model, DSM version, uptime, temp, CPU/memory |
| `nas_storage_health` | volumes (RAID, size), drives (S.M.A.R.T., temp) |
| `nas_packages_list` | installed packages + versions + status |
| `nas_packages_check_updates` | pending updates (excluding DSM itself) |
| `nas_package_info` | metadata for one package (publisher, changelog, deps) |
| `nas_security_advisor_scan` | Security Advisor check counts + the failing rules (passes/skips are counted, not listed) |
| `nas_users_list` | accounts, 2FA on/off, expired flag |
| `nas_firewall_list` | rules, auto-block, per-adapter DoS protection |
| `nas_dsm_security_settings` | web hardening (HTTPS-redirect/HSTS/CSRF/CSP/IP-check/session-timeout), TLS profile per service, SSH, SMB, NFS, auto-update, password policy, Active Insight |
| `nas_shares_list` | shares incl. encryption, quota (mb used/total), recycle-bin, snapshot support |
| `nas_external_access` | QuickConnect, DDNS, App Portal HTTPS-per-app, reverse-proxy rules, port forwarding |
| `nas_notifications` | SMTP mail config — server, ssl, verify-cert, sender, recipient count |
| `nas_certificates` | Cert inventory with `days_until_expiry`, services, self-signed flag |

**Write tools (per-call user confirmation required, see Write flow below):**

| Tool | Effect | Returns |
|---|---|---|
| `nas_package_install` | Install a new package from the Synology repo | `{ before, after, verified }` |
| `nas_package_update` | Update an installed package to latest | `{ before, after, verified }` |
| `nas_package_uninstall` | Remove an installed package | `{ before, after, removed }` |

## Write flow

All three write tools (install, uninstall, update) require explicit per-call user confirmation. **No silent writes, no batched writes across multiple packages in one turn.**

For each call:

1. Read the current state first (`nas_packages_list` or `nas_package_info`).
2. Render this exact confirmation block in prose and wait for a literal `yes`:
   ```
   Update proposed:
     package: <name>
     action:  <install | uninstall | update>
     before:  <current version or "not installed">
     after:   <expected version or "removed">
   Confirm? (yes/no)
   ```
   Anything other than `yes` aborts. Don't infer consent from "sure", "ok", "go ahead".
3. Call the write tool with exactly the args you just confirmed.
4. The tool returns `{ before, after, verified | removed }`. Check `verified === true` (or `removed === true`). On any mismatch, surface it loudly — silent drift is the worst outcome.
5. Repeat from step 1 for the next package. Never bundle multiple write tool calls in a single turn.

### Mechanics (install + update)

Both run the same DSM-UI-equivalent single-call sequence: `Package.feasibility_check` → `Installation.get_queue` → `Installation.check` (v=2) → `Installation.{install,upgrade}` with the catalog URL/checksum/size as a single call (no separate task_id download phase, despite what N4S4's docs claim). Then poll until the version flips on `Package.list`. Cleanup of the staged .spk in `/run/synopkg/tmp/` is best-effort.

If a write returns `verified: false`, surface the entire `{ before, after, error }` payload to the user. Don't retry automatically — the most likely cause is a Package Center precondition (TOS acceptance for a fresh user, package conflict, etc.) that needs human judgment.

First-time-only gotcha: if Package Center API calls return weird errors on a freshly-set-up `claude-mcp` account, the user may need to log into DSM UI **as `claude-mcp` once** and accept the Package Center TOS. Surface this as a hypothesis if a package operation behaves unexpectedly on a brand-new install — for an established install it doesn't apply.

**Server-side hard refusals** (the MCP will reject with an error):
- `nas_package_update("DSM")` — DSM self-updates are out of scope; apply via DSM UI.
- Kernel-flagged packages — same reason.
- Firewall rule edits, 2FA enforcement changes, SMB protocol toggles — not implemented as writes. Surface as findings with the DSM UI path to fix.

**DSM API gotcha** — `SYNO.API.Info`'s `requestFormat:"JSON"` describes the *response*, not the request. Every working DSM endpoint expects form-encoded params (GET querystring or POST `application/x-www-form-urlencoded`) regardless of what API.Info says. Array-typed params like `configs=[{"adapter":"eth0"}, ...]` go as a single form field whose value is the JSON-stringified array.

## Protected packages (per-user policy)

The user maintains a `protect:` list of packages that must never be offered for uninstall, even if they look dormant. Load the list at the start of any cleanup workflow from whatever path the user has configured for this skill's policy file; never offer protected packages.

## Audit log

Every write is logged to `/volume1/docker/synology-mcp/audit/YYYY-MM.jsonl` on the NAS, with timestamp, tool, args, before/after state, ok flag, and error message if any. Surface this path when the user asks "what did Claude do?" — they can read it themselves.


## Composition examples (do not script — Claude composes)

- **Package update from a Synology notification email**: search Gmail for the notification → cross-reference with `nas_packages_check_updates` → render per-package summary → confirm one at a time → `nas_package_update` (verifies post-state internally) → archive the email when all confirmed updates succeed.
- **Security audit**: fan out reads in parallel, group findings by severity, present DSM-UI fix paths (never auto-remediate).
- **Cleanup**: list packages, bucket as active / dormant / candidate (system + protected packages never appear as candidates), present dormant + candidate list with reasoning, confirm one at a time. **Only packages with `additional.install_type !== "system"` are user-removable** — the DSM UI hides the uninstall button on system-marked packages even if they appear in Package Center.

## Audit finding IDs

When composing security-audit output, attach a stable `id: synology.<category>.<short_name>` to each finding so the user can diff across runs and you can track which findings are still open. Use these when they apply; coin new ones in the same pattern as needed.

| ID | Trigger |
|---|---|
| `synology.firewall.disabled` | `nas_firewall_list.firewall_enabled === false` |
| `synology.firewall.dos_off_on_adapter` | one entry per adapter with `dos_protect_enable === false` (include adapter name) |
| `synology.dsm.https_redirect_off` | `web_hardening.https_redirect === false` |
| `synology.dsm.hsts_off` | `web_hardening.hsts === false` |
| `synology.dsm.tls_profile_downgraded` | any service `current-level < default-level` (include service name) |
| `synology.dsm.default_dsm_ports` | `web_hardening.http_port === 5000` or `https_port === 5001` |
| `synology.smb.smb1_enabled` | `smb.min_protocol === 1` |
| `synology.ssh.enabled` | `ssh_enabled === true` (mostly an observation; flag if Tailscale ACL isn't tight) |
| `synology.users.admin_active` | user `admin` not in expired state |
| `synology.users.guest_active` | user `guest` not in expired state |
| `synology.users.no_2fa` | per-user finding when `otp_enabled === false` on a non-disabled account |
| `synology.notifications.no_recipients` | `notifications.mail.recipients_count === 0` while `mail.enabled === true` |
| `synology.notifications.smtp_verify_cert_off` | `mail.verify_cert === false` |
| `synology.shares.no_encryption` | per-share when `encryption === 0` and share holds user data |
| `synology.shares.no_recycle_bin` | per-share when `recycle_bin === false` on a user-data share |
| `synology.cert.expiring_soon` | per-cert when `days_until_expiry < 30` |
| `synology.external.quickconnect_relay_on` | `quick_connect.enabled === false` AND `relay_enabled === true` (half-configured) |
| `synology.password.weak_policy` | min_length < 12, no special_char requirement, history_num === 0, etc. |
| `synology.privacy.active_insight_on` | `active_insight.monitoring_service === true` (observation only) |
| `synology.packages.outdated` | `nas_packages_check_updates.pending` non-empty |

The point isn't exhaustive coverage — it's stable IDs for the load-bearing findings. New checks coin new IDs in the same pattern (`synology.<category>.<short_name>`).
