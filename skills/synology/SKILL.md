---
name: synology
description: Manage a Synology NAS (DSM 7) — packages, security audit, shares — via the synology-nas-mcp server. Use when the user asks about NAS status, package updates / research / installation / removal, security posture, or Time Machine share configuration.
---

# Synology NAS

The `mcp__synology__*` tools talk to a self-hosted MCP server running on the NAS itself. Auth (DSM SID + TOTP) and the wire bearer token are owned by the server — this skill is workflow guidance only. The DSM account (`claude-mcp`) is in the `administrators` group because DSM 7 gates the admin APIs on that membership; compensating controls (2FA, no SSH service, Tailscale ACL, bearer token) live outside this skill — don't relax them.

## When to use

- **Status + storage**: "is the NAS okay?", "drive health", "RAID state".
- **Packages**: list installed, check for updates, get info, install, update, uninstall.
- **Package research**: "what's a good package for X?", "should I install Y?" — compose with WebSearch + `nas_packages_list` (to avoid recommending what's already there).
- **Security audit**: "audit security", "is my NAS configured safely?" — compose Security Advisor scan + users + firewall + DSM settings + shares + storage.
- **Time Machine inspection**: NAS-side share config + quota. For Mac-side backup *state*, see below.

## Tool inventory

**Read tools (free to invoke):**

| Tool | Returns |
|---|---|
| `nas_status` | model, DSM version, uptime, temp, CPU/memory |
| `nas_storage_health` | volumes (RAID, size), drives (S.M.A.R.T., temp) |
| `nas_packages_list` | installed packages + versions + status |
| `nas_packages_check_updates` | pending updates (excluding DSM itself) |
| `nas_package_info` | metadata for one package (publisher, changelog, deps) |
| `nas_security_advisor_scan` | Security Advisor findings, grouped by severity |
| `nas_users_list` | accounts, 2FA on/off, expired flag |
| `nas_firewall_list` | rules, auto-block, DoS protection |
| `nas_dsm_security_settings` | web hardening (CSRF/CSP/IP-check/session-timeout), SSH, SMB, auto-update, password policy |
| `nas_shares_list` | shares incl. encryption, quota (mb used/total), recycle-bin, snapshot support |

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

**Known read-tool gaps** (covered by Security Advisor findings; fix path is HITL HAR capture):
- HTTPS-enforce + min-TLS toggle — `SYNO.Core.Web.DSM` requires JSON-format requests our client doesn't speak.
- `SYNO.Core.Security.DoS.get` — returns 114 / 101 across versions; needs different params or a different API name.

## Protected packages (local config)

a local config file has a `protect:` list. Never offer those for uninstall, even if they look dormant. Read the file at the start of any cleanup workflow.

## Mac-side Time Machine state

The NAS knows the *share configuration*. The actual *backup state* (last successful, in-progress, errors) lives in `tmutil` on the Mac being backed up. When the user asks about Time Machine, do both:

- NAS side: `nas_shares_list` → locate the Time Machine share by name (DSM 7's share API doesn't expose an explicit TM flag) → report `quota_mb`, `quota_used_mb`, `encryption`.
- Mac side (if running locally on the Mac being backed up): shell out via Bash to
  - `tmutil destinationinfo` (confirms which destination is configured)
  - `tmutil status` (in-progress, errors)
  - `tmutil latestbackup` (timestamp of last successful backup)

If you're invoked from a context without local Bash to the backing-up Mac (e.g., a dispatched session on a different host), report NAS-side only and tell the user why.

## Audit log

Every write is logged to `/volume1/docker/synology-nas-mcp/audit/YYYY-MM.jsonl` on the NAS, with timestamp, tool, args, before/after state, ok flag, and error message if any. Surface this path when the user asks "what did Claude do?" — they can read it themselves.


## Composition examples (do not script — Claude composes)

- **Package update from a Synology notification email**: search Gmail for the notification → cross-reference with `nas_packages_check_updates` → render per-package summary → confirm one at a time → `nas_package_update` (verifies post-state internally) → archive the email when all confirmed updates succeed.
- **Security audit**: fan out reads in parallel, group findings by severity, present DSM-UI fix paths (never auto-remediate).
- **Cleanup**: list packages, bucket as active / dormant / candidate (system + protected packages never appear as candidates), present dormant + candidate list with reasoning, confirm one at a time.
