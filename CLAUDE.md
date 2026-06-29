# CLAUDE.md — synology-nas-mcp

Onboarding for a future Claude session (or any human collaborator). What's here that you can't easily get from the README, source files, or `git log`.

## What this is, in a paragraph

A small MCP server that exposes a typed subset of the Synology DSM 7 Web API (packages, security audit, shares, storage health, users, firewall, DSM hardening, external access, notifications, certificates, data protection) so an AI agent can manage the NAS. It deploys as a Docker container *on the NAS itself* (Container Manager → Project), bound to the Tailscale interface, with bearer-token + Origin auth on the HTTP endpoint. Auth to DSM is a dedicated `claude-mcp` user (`administrators` group, 2FA TOTP, no shared-folder access), credentials read at boot from 1Password via the `op` CLI. Claude Code talks to it natively over HTTP; Claude Desktop (which only accepts stdio MCP entries) talks to it via a thin stdio→HTTP bridge running locally on the user's Mac.

```
   Claude Desktop ──┐                                      ┌── NAS ─────────────────┐
                    │                                      │                         │
                    │  stdio (spawned per session)         │  Container Manager      │
                    ▼                                      │  ┌───────────────────┐  │
       /opt/homebrew/bin/synology-nas-mcp bridge ───tailnet───▶│ synology-nas-mcp: │  │
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

`src/cli.ts` exposes three subcommands:

| Subcommand | Transport | Where it runs | When you use it |
|---|---|---|---|
| `serve` | stdio | local dev only | `claude mcp add … -t stdio` for testing the server logic without HTTP. Rarely used. |
| `daemon` | Streamable HTTP | NAS container | The production deploy. Reads creds via `op`, binds tailscale0, listens on :8765. |
| `bridge` | stdio → HTTP client | the user's Mac (Claude Desktop) | Tiny proxy. Reads `MCP_BRIDGE_URL` + `MCP_BRIDGE_TOKEN` env, forwards stdio JSON-RPC to the daemon. ~40 lines. Lives at `/opt/homebrew/bin/synology-nas-mcp` after `npm install -g .` |

## Deploy loop (the commands you'll actually run)

`docs/SETUP.md` covers first-time install. For incremental development:

```sh
# On the Mac (Colima or Docker Desktop running for cross-arch builds):
cd <repo>
docker build --platform linux/amd64 \
  -t synology-nas-mcp:<ver> -t synology-nas-mcp:latest .
docker save synology-nas-mcp:<ver> synology-nas-mcp:latest \
  -o ~/Downloads/synology-nas-mcp-<ver>.tar

source dev/source-creds.sh   # once per shell; reads creds from 1Password via op
npm run deploy                # ~30s: upload+import+stop+build+start+/health-verify
```

`npm run deploy` (`src/dev/deploy.ts`) uses two DSM Web API quirks that aren't in any public doc:

- **Image upload URL pattern** `/webapi/entry.cgi/SYNO.Docker.Image?api=…&method=upload&version=1` (the API name embedded as a URL path segment, not a query param). The multipart-form field carrying the file body is named `filename` — DSM reuses the same word for both the form `name=` and the multipart `filename=` metadata.
- **`X-SYNO-TOKEN` header** mandatory on mutating Docker.* and Package.* endpoints. Without it you get code 119 ("SID not found") even with a valid SID.

Both reverse-engineered from a DevTools HAR capture.

When bumping the version, only update `package.json` — `src/version.ts` reads it at startup and both `server.ts` and `http.ts` import the constant. The docker tag in the build command is just the human-facing label; nothing depends on it matching.

## Write flow: install & update (two-phase, download then install-from-path)

`src/tools/packages.ts:nasPackageUpdate` runs the DSM UI's exact sequence — re-verified from a HAR capture on 2026-05-20. The first `Installation.upgrade` only downloads the .spk; a **second** `Installation.upgrade` with `path` + `installrunpackage:true` is what actually installs. The v0.2.11–v0.2.25 implementation thought the first call did everything and silently failed on packages that don't auto-install post-download (HybridShare, FileStation — left orphaned .spks in `/volume1/@tmp/synopkg/download.*/`).

1. **`SYNO.Core.Package.feasibility_check`** — preflight.
2. **`SYNO.Core.Package.Installation.get_queue`** — dep planning. Bail on `broken_pkgs`/`conflicted_pkgs`.
3. **`SYNO.Core.Package.Installation.check` v=2** — `blupgrade=true`, `ver`/`size`/`id`. Returns `volume_path`.
4. **`SYNO.Core.Package.Installation.upgrade` v=1** — DOWNLOAD. Params: `name`/`url`/`checksum`/`filesize`/`is_syno`/`beta`/`operation:"upgrade"`. Returns `taskid="@SYNOPKG_DOWNLOAD_<id>"`.
5. **Poll `Installation.status`** until `finished:true` — .spk is on disk.
6. **`SYNO.Core.Package.Installation.Download.check`** — returns `filename`, the staged .spk path.
7. **`SYNO.Core.Package.Installation.check` v=2** — simpler shape: `id`/`install_type`/`install_on_cold_storage`/`blCheckDep:false`. No `ver`/`size`/`blupgrade`.
8. **`SYNO.Core.Package.Installation.upgrade` v=1** — INSTALL FROM PATH. Params: `path`, `extra_values:"{}"`, `installrunpackage:true`, `force:true`, `check_codesign:true`, `type:0`. Throw on non-empty `worker_message`.
9. **Poll `Package.list`** until `version` flips (`Installation.status` keeps reporting `"upgrading"` long after the actual swap, so it isn't reliable). 15-min timeout.
10. **`Installation.delete path=<staged>`** — cleanup; best-effort.

`nasPackageInstall` now uses the **same two-phase split**, verified against the live NAS — the prediction in earlier revisions of this doc came true. Step 4's `Installation.install` only *downloads* (status flips to `"installing"` but `Download.check` reports `status:"non_installed"` / "failed to locate given package", and the package never lands in `Package.list`); the commit is a **second** `Installation.install` with `path` + `installrunpackage:true` + `force:true` + `check_codesign:true` (step 8, method `install` not `upgrade`, plus `volume_path`). Before the fix, the missing commit made the completion poll wait for a version flip that never came → silent spin to the 15-min timeout → the client's undici bodyTimeout (~300s, no SSE heartbeats) dropped the call ("transport dropped mid-call"). The commit returns in seconds; install waits are now bounded (`INSTALL_DOWNLOAD_TIMEOUT_MS` 3 min, `INSTALL_VERIFY_TIMEOUT_MS` 90 s) so a stuck op fails fast with "issued but not confirmed — poll nas_packages_list" instead of hanging.

**Dependencies (the queue is the source of truth).** Catalog `depend_packages` is unreliable — it was `null` for Synology Drive Server, which nonetheless requires Universal Viewer. `Installation.get_queue` returns DSM's fully-resolved, ordered plan (deps first, target last), e.g. `[UniversalViewer, SynologyDrive]`; `nasPackageInstall` executes that flat list verbatim, each entry two-phase. When the queue contains packages beyond the target, the tool returns `status:"needs_dependency_confirmation"` listing them (mirroring Package Center's confirmed "the following operations will also be performed" dialog) and installs nothing until re-called with `accept_dependencies:true`. The second-phase commit on big packages (Synology Drive registers many `dsm_apps`) frequently drops the TCP connection mid-call but succeeds server-side — `applyInstallFromPath` treats network-level errors as soft and confirms via the `Package.list` poll, same as `controlPackage`. (With a dependency *unmet*, `Download.check` returns code **4526** naming the dep — but the queue-first execution means that path isn't normally reached.)

**Form-encoding gotcha.** DSM JSON-parses each form value. Strings must carry quotes on the wire (`name="FileStation"`), bools/numbers/null are literal, arrays/objects are JSON-stringified. The code uses `JSON.stringify(...)` for string values so they appear quoted in the form body.

**Uninstall** is a single call: `SYNO.Core.Package.Uninstallation.uninstall` with `id` and `dsm_apps=""`. The `dsm_apps` field is a list of linked DSM apps to remove together, NOT a "keep data" flag.

**Uninstall data deletion is package-specific (HAR-verified 2026-06-23).** Package Center's "Delete the items listed above" checkbox rides `extra_values` carrying a **per-package** wizard key — `"{\"pkgwizard_remove_cstn_db\":true}"` for Synology Drive; ABB and others differ. That key is defined in each package's own client-side uninstall wizard, NOT exposed by any queryable API (`is_uninstall_pages:true` in `Package.list` only flags that a dialog *exists*; there's no precheck method — `Uninstallation` has only `uninstall`). So the MCP can detect a data-bearing package but can't safely drive its delete-data option blind. `nasPackageUninstall` therefore only ever does the **data-preserving** uninstall (omit `extra_values`): when `is_uninstall_pages` is true it returns `status:"needs_data_confirmation"` and requires `keep_data:true` to proceed; `keep_data:false` is refused with a pointer to the DSM UI (the honest path for actual deletion). Mirrors the install dependency-confirmation pattern.

## DSM API quirks (the consolidated cheatsheet)

A reference of error codes, response shapes, and known API names is at [`docs/dsm-api-quirks.md`](docs/dsm-api-quirks.md) — read it before adding new tools or debugging unexpected `code:` errors. Highlights:

- Error 114 = "Lost parameters" (NOT "API key mismatch"). 5100 = "Unable to perform" (NOT empty list).
- `requestFormat: "JSON"` in `SYNO.API.Info` describes the **response**, not the request — always send form-encoded.
- `additional[]` response keys are FLAT on User/Share objects but NESTED under `additional` on Package objects.
- Per-adapter calls (DoS, GeoIP) use `configs=[{adapter: ifname}, ...]` as a JSON-stringified single form field.
- State-changing POSTs (e.g., `Package.Control.stop`, `Installation.install` from-path) frequently drop the TCP connection mid-execution while completing server-side — catch network-level errors and verify via status/list poll.
- A streamable-HTTP MCP tool call rides one long-lived response with **no SSE heartbeats**, so the client's undici bodyTimeout (~300s) drops it if nothing returns in time. `http.ts` disables Node's 300s `requestTimeout` (so the server doesn't add its own cut), but each tool must still bound its own work to return inside the client window — the package flow does (`INSTALL_*_TIMEOUT_MS`). Ops that legitimately exceed ~250s would need SSE keepalives (not yet wired).

## Hard-won lessons, in roughly the order we learned them

These are gotchas that aren't obvious from the code. Each one was a real bug we hit.

### 1Password item names: ASCII hyphen only

`op read op://vault/item/field` rejects unicode dashes (em-dash `—`, en-dash `–`) in item names with "invalid character in secret reference." Spaces are fine; only the dashes need to be ASCII. The default in `config.ts` is `Synology DSM - claude-mcp` — don't change it to the prettier em-dash.

### `claude-mcp` has to be in `administrators`

DSM 7's admin APIs (`SYNO.Core.Package.*`, `SYNO.SecurityAdvisor.*`, `SYNO.Core.User.*`, `SYNO.Core.Share`, etc.) gate on `administrators` group membership. There's no selective-grant mechanism — DSM's "Application Privileges" page covers only end-user services (File Station, SMB, AFP). An earlier draft of this repo planned a non-admin claude-mcp user; that was wrong about what DSM supports.

Compensating controls (documented in `docs/SETUP.md`): password only in 1Password (never typed), 2FA TOTP enforced, no shared-folder access, no SSH service running, Tailscale ACL restricts ports to your devices, bearer + Origin on the MCP endpoint.

### Synology Tailscale is userspace-networking — bind loopback + `tailscale serve`

Even with `network_mode: host`, `os.networkInterfaces()` inside the container doesn't list `tailscale0`, and the CGNAT-range scan in `src/http.ts` (`100.64.0.0/10`) comes up empty on a DS224+ — because the Synology Tailscale package runs **userspace-networking**, so there is no kernel `tailscale0` interface to enumerate or bind.

The hardened deploy model (Option A): set `MCP_BIND_HOST=127.0.0.1` in the NAS `.env` so the daemon binds **loopback only**, and front it with host `tailscale serve --bg --https=443 http://127.0.0.1:8765`. The LAN then can't reach `:8765` at the socket layer (nothing bound on the LAN IP — connection-refused, verified); tailnet devices reach it via serve (`:443`, HTTPS, real `*.ts.net` cert) and, as a side effect of userspace-networking, also via the tailnet IP on `:8765` which tailscaled forwards to loopback. Both paths still pass through the bearer + Origin checks. Serve config persists across reboots (tailscaled state). Clients use `https://<nas>.<tailnet>.ts.net/mcp`. See `docs/SETUP.md` → "Network model".

If `MCP_BIND_HOST` is left empty, `resolveBindHost` falls back to `0.0.0.0` (LAN-reachable, defended only by bearer/ACL/Origin) — that's the unconfigured path, not the recommended one.

### Streamable HTTP **stateless** mode requires a fresh `McpServer` per request

The MCP SDK's `sessionIdGenerator: undefined` (stateless) mode requires a new `McpServer` + new `StreamableHTTPServerTransport` for *every* HTTP request. Sharing one server across requests works for the first call, then 500s on every subsequent one. The `DsmClient` is hoisted outside the per-request scope so we keep the SID cache warm.

### Bridge must filter `notifications/initialized` and `.catch` send rejections

In stateless HTTP mode the server has no session to mark "initialized," so forwarding the notification yields a 500. The bridge swallows all `notifications/*` from client → server. Also: Node 22+ kills the process on unhandled promise rejections, so every `transport.send(msg)` in the bridge must `.catch`.

### DSM rejects TOTP code reuse within the 30s window

The first DSM login generates a TOTP code; if that exact code was used within the last 30 seconds (e.g., by an earlier container instance or rapid back-to-back `tsx` dev runs), DSM responds with error code 404 = "Failed to authenticate 2-factor authentication code." Wait ~30s and retry. The auto-retry path on `code 117/119` (SID expired) covers most cases. For dev iteration, `DSM_SID_CACHE_FILE` persists the SID across processes.

### `SYNO.Core.Package.Server.list?tab=update` is the catalog, not pending updates

It returns the entire catalog of packages installable on this DS — 105+ items, no `installed_version` field. To get pending updates, join with `SYNO.Core.Package.list` (the installed set with versions) and filter to items where `installed_version` is set AND `installed_version !== catalog_version`. See `tools/packages.ts:nasPackagesCheckUpdates`.

### DSM Web API is reverse-engineered, not specced

`SYNO.*` is not a public, versioned spec. Synology publishes a partial guide (mainly Auth + FileStation); the rest is reverse-engineered from DSM's own JS clients. When adding a new tool, **inspect DSM's UI network tab** for the exact `api/method/version/params` the official client sends, then mirror. Don't trust third-party docs alone — widely-cited community references can lag current DSM behavior. We shipped an upgrade bug in v0.2.7–0.2.10 by following one before reverse-engineering the real flow from a HAR.

### Hard refusals live in `tools/packages.ts`, not `server.ts`

`HARD_REFUSE_NAMES = new Set(["DSM", "kernel"])`. If you find yourself wanting to add a refusal at the server-registration layer, push it down into the tool function so the JSONL audit log captures the rejected attempt with full args. Server-registration refusals are silent from the audit's perspective.

### Zod schemas live only in `server.ts`; tool files declare their own arg types

`server.ts` is the MCP boundary — that's where input validation happens via `z.object({...})` per tool. Tool functions in `tools/*.ts` declare their `args` parameter with a hand-written TS type (`{name: string; action: "start" | "stop" | "restart"}`) instead of `z.infer<typeof schema>`. The drift risk is real (rename a field in one, forget the other), but the alternative is worse: deriving the tool's arg type from the schema would force every tool file to import zod, which expands the import graph and bleeds the boundary into the rest of the codebase. The current layering keeps zod confined to where it does its job and lets tool files stay zod-free. If drift becomes a recurring bug source, revisit — but premature unification adds a dependency constraint that's harder to undo than to add.

### `protect:` policy is skill-layer, not server-enforced

The skill prompt (see `skills/synology/SKILL.md`) loads a per-user policy file naming packages the user doesn't want offered for uninstall (e.g. HyperBackup, ContainerManager, Tailscale). The MCP server doesn't read this file — refusal happens in the calling skill before it ever invokes `nas_package_uninstall`. Server-side hard refusals are only `DSM` and `kernel`. The location and format of the policy file are the user's choice; the skill consumes whatever path they configure.

### Bearer rotation

`mcp_bearer_token` in 1Password is the single source of truth. Rotation = generate new value → update 1Password → restart container → update `claude_desktop_config.json`'s `MCP_BRIDGE_TOKEN` on every Mac that points here → restart Claude clients.

### TLS verification is process-wide via `NODE_TLS_REJECT_UNAUTHORIZED=0`

v0.2.12 tried a per-fetch `undici` Agent for scoped TLS skip; it interacted badly with Node 22's built-in fetch (intermittent "fetch failed" + silently-empty responses on some endpoints). v0.2.14 reverted to process-wide skip via the `NODE_TLS_REJECT_UNAUTHORIZED=0` env var set at startup when `cfg.tlsSkipVerify` is true. The blast radius is bounded: the daemon only talks to DSM at `cfg.dsmBaseUrl`; there are no other outbound HTTPS calls. If you add one, route it explicitly through a verifying agent or restore the per-fetch scoping.

### No `synology-api` npm dep on purpose

There are several `synology-*` npm packages. None covered SYNO.Core.Package, SYNO.SecurityAdvisor.*, and SYNO.Core.Share with the field-level options we need. Rolling our own thin client (~200 lines in `dsm.ts`) was cleaner than wrapping a community lib for partial coverage. Don't add a dep here unless one of them grows into mature coverage.

## Deliberately deferred (don't pre-build)

These are conscious omissions, not gaps. If a future request actually requires one, add it then.

- Firewall rule edits, 2FA enforcement changes, SMB protocol toggles — out of scope; surface as findings only.
- DSM self-update — would brick the connection mid-call.
- Btrfs snapshot helper — users can snapshot via DSM UI if they want pre-mutation insurance.
- Recent-logins, SecAdvisor history — none mapped to a stated user request.
- An `nas_audit_log` read tool — JSONL is on disk; reading it is a file-system op, not an MCP one.
- ~~Transitive dependency installs.~~ **Shipped** — `nas_package_install` executes DSM's resolved `get_queue` plan (deps first, target last) after a `needs_dependency_confirmation` round-trip. The old "too much blast radius" worry was about *us* recursively chasing deps-of-deps; in practice DSM hands back the complete ordered queue in one call, so executing it is bounded and matches the Package Center UI. See the Write-flow section.
- Cold-storage installs. We pass `install_on_cold_storage` from the catalog through to `Installation.check`; if a user hits a package whose catalog flag forces cold-storage and DSM refuses, they fall back to the UI.
- Package-specific `extra_values` (e.g. SurveillanceStation needs `chkSVS_Alias: true`). DSM's UI handles these via dedicated form dialogs. The MCP install path uses the upgrade-style shape that doesn't require `extra_values`; if you encounter a package that needs custom values, install via DSM UI once and let the persisted state cover subsequent updates.
