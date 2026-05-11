# CLAUDE.md — synology-nas-mcp

Onboarding for a future Claude session (or any human collaborator). What's here that you can't easily get from the README, source files, or `git log`.

## What this is, in a paragraph

A small MCP server that exposes a typed subset of the Synology DSM 7 Web API (packages, security audit, shares, storage health) so an AI agent can manage the NAS. It deploys as a Docker container *on the NAS itself* (Container Manager → Project), bound to the Tailscale interface, with bearer-token + Origin auth on the HTTP endpoint. Auth to DSM is a dedicated `claude-mcp` user with 2FA, credentials read at boot from 1Password via the `op` CLI. Claude Code talks to it natively over HTTP; Claude Desktop (which only accepts stdio MCP entries) talks to it via a thin stdio→HTTP bridge running locally on the user's Mac.

```
   Claude Desktop ──┐                                      ┌── DS224+ ──────────────┐
                    │                                      │                         │
                    │  stdio (spawned per session)         │  Container Manager      │
                    ▼                                      │  ┌───────────────────┐  │
       /opt/homebrew/bin/synology-nas-mcp bridge ───tailnet───▶│ synology-nas-mcp:│  │
                    ▲                                      │  │   (Node.js)       │  │
                    │  HTTP + bearer                       │  │  HTTP daemon      │  │
   Claude Code ─────┘                                      │  └─────────┬─────────┘  │
                                                            │            │            │
                                                            │            ▼            │
                                                            │   localhost DSM API     │
                                                            │   (op-fetched creds)    │
                                                            └─────────────────────────┘
```

## Three CLI modes

`src/cli.ts` exposes three subcommands. Each has a specific deployment use:

| Subcommand | Transport | Where it runs | When you use it |
|---|---|---|---|
| `serve` | stdio | local dev only | `claude mcp add … -t stdio` for testing the server logic without HTTP. Rarely used. |
| `daemon` | Streamable HTTP | NAS container | The production deploy. Reads creds via `op`, binds tailscale0, listens on :8765. |
| `bridge` | stdio → HTTP client | the user's Mac (Claude Desktop) | Tiny proxy. Reads `MCP_BRIDGE_URL` + `MCP_BRIDGE_TOKEN` env, forwards stdio JSON-RPC to the daemon. ~40 lines. Lives at `/opt/homebrew/bin/synology-nas-mcp` after `npm install -g .` |

## Deployment

See `docs/SETUP.md` for the full walkthrough. The short version:

1. **One-time NAS prep**: install Container Manager + Synology Tailscale packages; create the `claude-mcp` DSM user (`administrators` group, 2FA TOTP, no shared-folder access, no SSH); create the 1Password item + service account; add Tailscale ACL restricting :8765 to your devices.
2. **One-time Mac prep**: `npm install -g .` to install the bridge globally; wire Claude Desktop's `claude_desktop_config.json` to invoke `/opt/homebrew/bin/synology-nas-mcp bridge` with the env; `claude mcp add synology http://nas.local:8765/mcp -t http --header "Authorization: Bearer …" -s user` for Claude Code.
3. **Per-deploy**: build the image locally (cross-build to `linux/amd64` because the DS is x86_64), `docker save` to a tar, upload to `/volume1/docker/synology-nas-mcp/` via File Station, **Image → Add from file**, **Project → Action → Build**. Env vars in the project's `docker-compose.yml` survive across rebuilds — no re-entry.

## Rebuild + redeploy (the commands you'll actually run)

```sh
# On the Mac:
colima start                                                  # if not running
cd ~/Dropbox/Code/synology-nas-mcp
docker build --platform linux/amd64 \
  -t synology-nas-mcp:0.1.X -t synology-nas-mcp:latest .
rm -f ~/Downloads/synology-nas-mcp-latest.tar
docker save synology-nas-mcp:latest synology-nas-mcp:0.1.X \
  -o ~/Downloads/synology-nas-mcp-latest.tar
# (if you also updated bridge code:)
npm install -g .
colima stop
```

Then upload the tar to the NAS, import in Container Manager → Image, Project → Action → Build.

When bumping the version, you must update **all four** of these in sync, or `/healthz` and the tar tag get out of step:
- `package.json` `"version"`
- `src/server.ts` `version: "0.1.X"`
- `src/http.ts` `version: "0.1.X"` (the `/healthz` response)
- `docker build -t synology-nas-mcp:0.1.X`

`synology.compose.yml` references `:latest` — leave that alone.

## Hard-won lessons, in roughly the order we learned them

These are gotchas that aren't obvious from the code. Each one was a real bug we hit.

### 1Password item names: ASCII hyphen only

`op read op://vault/item/field` rejects unicode dashes (em-dash `—`, en-dash `–`) in item names with "invalid character in secret reference." Spaces are fine; only the dashes need to be ASCII. The default in `config.ts` is `Synology DSM - claude-mcp` — don't change it to the prettier em-dash. If you rename the 1Password item, mirror the new name to `DSM_OP_ITEM` env var on the container.

### `claude-mcp` has to be in `administrators`

DSM 7's admin APIs (`SYNO.Core.Package.*`, `SYNO.SecurityAdvisor.*`, `SYNO.Core.User.*`, `SYNO.Core.Share`, etc.) gate on `administrators` group membership. There's no selective-grant mechanism — DSM's "Application Privileges" page covers only end-user services (File Station, SMB, AFP). An earlier draft of this repo planned a non-admin claude-mcp user with selective Package Center / Security Advisor access; that was wrong about what DSM supports.

Compensating controls are documented in `docs/SETUP.md` ("Why administrators"). Don't quietly relax them: password only in 1Password (never typed), 2FA TOTP enforced, no shared-folder access, no SSH service running, Tailscale ACL restricts ports to your devices, bearer + Origin on the MCP endpoint.

### Synology Container Manager hides Tailscale from `host`-networked containers

Even with `network_mode: host`, `os.networkInterfaces()` inside the container doesn't list `tailscale0` (or any Tailscale-named interface). The CGNAT-range scan in `src/http.ts` (`100.64.0.0/10`) also comes up empty on a DS224+. So `resolveBindHost` falls back to `0.0.0.0`. That's safe because: (a) the tailnet ACL restricts :8765 to your own devices, (b) the bearer token gates every `/mcp` request, (c) the Origin check rejects DNS-rebinding.

If you want stricter binding, set `MCP_BIND_HOST` to the NAS's Tailscale IP explicitly — but it's not necessary.

### Streamable HTTP **stateless** mode requires a fresh `McpServer` per request

The MCP SDK's `sessionIdGenerator: undefined` (stateless) mode requires a new `McpServer` + new `StreamableHTTPServerTransport` for *every* HTTP request. Sharing one server across requests works for the first call, then 500s on every subsequent one — the server gets stuck in a "ready" state. See `src/http.ts`. The `DsmClient` is hoisted outside the per-request scope so we keep the SID cache warm.

### Bridge must filter `notifications/initialized`

The MCP client lifecycle is `initialize → notifications/initialized → tools/list → tools/call`. In stateless HTTP mode, the server has no session to mark "initialized," so forwarding the notification yields a 500. The bridge swallows all `notifications/*` from client → server. Server → client notifications are forwarded; the client can ignore unrecognized ones.

### Bridge must `.catch` send rejections

Node 22+ kills the process on unhandled promise rejections. The bridge's `downstream.onmessage = (msg) => upstream.send(msg)` returns a Promise; if it rejects (e.g., the daemon returns 500), the unhandled rejection takes down the bridge. Then Claude Desktop spawns a fresh bridge for the next message, which also crashes, and so on. Always `.catch` send rejections at the bridge layer. See `src/cli.ts`'s `bridge()`.

### DSM rejects TOTP code reuse within the 30s window

On container restart, the first DSM login generates a TOTP code. If that exact code was used within the last 30 seconds (e.g., by an earlier container instance), DSM responds with error code 404 = "Failed to authenticate 2-factor authentication code." Wait ~30s and retry. There's no caching trick here — DSM is doing the right thing rejecting replay. The auto-retry path on `code 117/119` (SID expired) covers most cases; this only bites at boot.

### `SYNO.Core.Package.Server.list?tab=update` is the catalog, not pending updates

It returns the entire catalog of packages installable on this DS — 105+ items, no `installed_version` field. To get pending updates, join with `SYNO.Core.Package.list` (the installed set with versions) and filter to items where `installed_version` is set AND `installed_version !== catalog_version`. See `tools/packages.ts` `nasPackagesCheckUpdates`.

### DSM Web API is reverse-engineered, not specced

`SYNO.*` is not a public, versioned spec. Synology publishes a partial guide (mainly Auth + FileStation); the rest is reverse-engineered from DSM's own JS clients. When adding a new tool, **inspect DSM's UI network tab** for the exact `api/method/version/params` the official client sends, then mirror. Don't trust third-party docs alone.

When a method's response shape changes between DSM minor versions, fail open in `tools/*.ts` (use `.catch(() => null)` for optional fields, then surface what we did get). The Security Advisor and DSM Settings APIs are particularly variable.

### SID lifetime

`SID_TTL_MS = 10 * 60 * 1000` in `dsm.ts` is *our* TTL, not DSM's. DSM's actual SID lifetime depends on Control Panel → Security → Logout timer (default 30 min idle). The 10-minute internal refresh is just an optimization; if it expires for real, the `code 117/119` retry path in `call()` handles it transparently.

### Hard refusals live in `tools/packages.ts`, not `server.ts`

`HARD_REFUSE_NAMES = new Set(["DSM", "kernel"])`. If you find yourself wanting to add a refusal at the server-registration layer, push it down into the tool function so the JSONL audit log captures the rejected attempt with full args. Server-registration refusals are silent from the audit's perspective.

### Bearer rotation

`mcp_bearer_token` in 1Password is the single source of truth. Rotation = generate new value → update 1Password → restart container (auto-reads on boot) → update `claude_desktop_config.json`'s `MCP_BRIDGE_TOKEN` on every Mac that points here → restart Claude clients. There is no in-flight rotation path.

### TLS bypass is process-wide

`cli.ts` sets `NODE_TLS_REJECT_UNAUTHORIZED=0` at startup when `cfg.tlsRejectUnauthorized` is false (the default — DSM uses a self-signed cert on `localhost:5001`). This affects every outbound fetch in the process. The MCP server only talks to DSM so the scope is bounded — but if you ever add another HTTP client here, remember that its TLS verification is also off.

### No `synology-api` npm dep on purpose

There are several `synology-*` npm packages. None covered SYNO.Core.Package, SYNO.SecurityAdvisor.*, and SYNO.Core.Share with the field-level options we need. Rolling our own thin client (~200 lines in `dsm.ts`) was cleaner than wrapping a community lib for partial coverage. Don't add a dep here unless one of them grows into mature coverage.

### Time Machine state lives on the Mac

The NAS only stores the SMB share config + quota. Backup *state* (last successful, in-progress, errors) is in macOS's `tmutil` on the Mac being backed up. The skill's `SKILL.md` tells Claude to shell out via Bash when running on that Mac; don't try to add an MCP tool for backup state — it would have to SSH to the Mac, which adds a whole separate auth surface we don't want.

## v0.2 roadmap: real write flow

`nas_package_install` / `_update` / `_uninstall` are stubbed in 0.1.x — they
return a clear "use DSM UI" error instead of half-working. The DSM 7 install
flow is multi-step async; we found this out by hitting error code 103 ("method
does not exist") on a naive single-call `install` and digging into how
`N4S4/synology-api` Python lib actually does it.

The flow to port:

1. **Catalog lookup**. `SYNO.Core.Package.Server.list?tab=update` for the
   target id. Pull `link` (url), `md5` (checksum), `size` (filesize),
   `version`, and `deppkgs`.
2. **Start download**. `SYNO.Core.Package.Installation` method `install`
   with `operation=install, type=0, blqinst=false, url, name, checksum,
   filesize`. Returns `{ taskid, progress }`.
3. **Poll download**. `SYNO.Core.Package.Installation` method `status`
   with `task_id`. Repeat until `finished=true` or `has_fail=true`.
   `progress` goes 0..1.
4. **Check downloaded file**. `SYNO.Core.Package.Installation.Download`
   method `check` with `task_id`. Returns `filename` (file_path).
5. **Check install feasibility**. `SYNO.Core.Package.Installation` method
   `check` with `id`, `install_type=""`, `install_on_cold_storage=false`,
   `breakpkgs=None`, `blCheckDep=false`, `replacepkgs=None`. Returns
   `volume_path` (where to install).
6. **Apply**.
   - Fresh install: `SYNO.Core.Package.Installation` method `install`
     with `type=0, volume_path, path=file_path, check_codesign=true,
     force=true, installrunpackage=true, extra_values={}`.
   - In-place upgrade: `SYNO.Core.Package.Installation` method `upgrade`
     with `task_id, type=0, check_codesign=false, force=false,
     installrunpackage=true, extra_values={}`.

For uninstall (single call, much simpler):
- `SYNO.Core.Package.Uninstallation` method `uninstall` with `id`,
  `dsm_apps=""`. Our v0.1.4 code passed `dsm_apps: "true"/"false"` which is
  wrong — that field is a list of DSM apps to also uninstall, not a "keep
  data" flag. Fix when wiring v0.2.

References: `N4S4/synology-api` repo, `synology_api/core_package.py`,
methods `download_package`, `get_dowload_package_status`,
`check_installation_from_download`, `check_installation`,
`install_package`, `upgrade_package`, `uninstall_package`, `easy_install`.
Easy_install shows the full orchestration including dependency resolution.

Audit log already records write attempts (with `ok: false, error` on the
stub case), so when v0.2 ships the real flow the JSONL history retroactively
explains every "DSM UI fallback" event.

## Deliberately deferred (don't pre-build)

These are conscious omissions, not gaps. If a future request actually requires one, add it then.

- Firewall rule edits, 2FA enforcement changes, SMB protocol toggles — out of scope; surface as findings only.
- DSM self-update — would brick the connection mid-call.
- Btrfs snapshot helper — users can snapshot via DSM UI if they want pre-mutation insurance.
- Cert inventory, recent-logins, SecAdvisor history — none mapped to a stated user request.
- An `nas_audit_log` read tool — JSONL is on disk; reading it is a file-system op, not an MCP one.
