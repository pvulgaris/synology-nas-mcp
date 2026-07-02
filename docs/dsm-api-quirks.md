# DSM 7 Web API quirks

Consolidated notes on the Synology DSM 7 Web API surface, derived from live probing and reverse-engineering work on this project. Read before adding new tools, debugging unexpected `code:` errors, or interpreting `SYNO.API.Info` output.

## Error codes

DSM error codes are NOT what they sound like — verified against [N4S4/synology-api's `error_codes.py`](https://github.com/N4S4/synology-api/blob/master/synology_api/error_codes.py) and our live probing:

| Code | Actual meaning | What it looks like |
|---|---|---|
| 101 | Invalid parameter or wrong version | Call shape mostly right; bump `version` or check params |
| 103 | Method not found | API exists; method doesn't. Often a renamed method (`list` → `load`, etc.) |
| 105 | Insufficient permissions | Even admin users hit this on some endpoints (e.g. `Notification.Rule.list`) |
| 114 | **"Lost parameters"** — missing a required param (NOT "API key mismatch") |
| 117 / 119 | SID expired — `SynoClient.call()` auto-retries with fresh login |
| 120 | Invalid `additional[]` key — DSM rejects unknown field names |
| 5100 | "Unable to perform" — generic internal failure (NOT "no records to return") |
| 5102 | Invalid enum value (e.g. `type=blocked` rejected; valid values are `allow`/`deny`) |

## Request format

- **`requestFormat: "JSON"` in `SYNO.API.Info` describes the *response* format, not the request.** Always send form-encoded params (GET querystring or POST `application/x-www-form-urlencoded`). Sending a JSON body yields 101 because DSM never parses api/method/version out of it.
- **Arrays go as a single form field with JSON-stringified value** — e.g. `configs=[{"adapter":"eth0"}]` URL-encoded into one param. Pattern used by `SYNO.Core.Security.DoS.get` and others that operate per-adapter.
- **POST is required for state-changing calls.** GET often yields 503 / "fetch failed" mid-flight. Set `post: true` on `DsmCallOptions`.
- **DSM frequently drops the TCP connection mid-execution on state changes** (`Package.Control.stop`, `Project.build`, etc.). The action still completes server-side. Catch network-level errors (`fetch failed` / `ECONNRESET` / `ETIMEDOUT` / `socket hang up`) and verify via a status-poll instead of bailing.

## Response shape

The biggest footgun: where `additional[]` keys appear in the response varies by API.

| API | Response field placement |
|---|---|
| `SYNO.Core.User.list` | Flat on each user object: `u.email`, `u["2fa_status"]` |
| `SYNO.Core.Share.list` | Flat on each share object: `s.encryption`, `s.enable_recycle_bin` |
| `SYNO.Core.Package.list` | Nested under `additional`: `p.additional.status`, `p.additional.install_type` |

Always probe with `DEBUG_DSM_RESPONSES=1` and look at the raw shape before mapping fields.

**`SYNO.Core.Package.Server.list` (the catalog, not the installed-package list) uses its own field
names, not the ones you'd guess from `Package.list` or the Package Center UI's labels:** display
name is `dname` (not `name`), publisher is `maintainer` (not `publisher`), description is `desc`
(not `description`), and dependencies are `deppkgs` (a `{pkgId: versionConstraint}` map or `null`
— not `depend_packages`). There is no `install_dep_packages` field on this endpoint at all;
`Installation.get_queue` is the resolved-plan source of truth (see the write-flow section in
CLAUDE.md). `nas_package_info` and `nas_packages_check_updates` shipped for a while silently
mapping the wrong keys — `JSON.stringify` drops `undefined` fields, so the gap only surfaced via a
live smoke test, not a type error (`dsm.call<T>()` performs an unchecked cast, so a wrong field
name in the TS interface never fails at compile time). `changelog`, `size`, and `beta` happen to be
named the same on both endpoints, which is what let the bug hide for the fields that did work.

## API name + method discoveries

These took multiple sessions to pin down:

- **HTTPS-redirect / HSTS**: `SYNO.Core.Web.DSM` v=2 `get` (no params)
- **TLS profile per service**: `SYNO.Core.Web.Security.TLSProfile` v=1 `get`
- **DoS protection**: `SYNO.Core.Security.DoS` v=2 `get` with `configs=[{adapter},...]`
- **Network interfaces (for the `configs=` pattern)**: `SYNO.Core.Network.Interface` v=1 `list`
- **Firewall rules per profile**: list profiles via `SYNO.Core.Security.Firewall.Profile` v=1 `list`, then `get` per `name`. There is NO `Firewall.Rules.list`.
- **AutoBlock entries**: `SYNO.Core.Security.AutoBlock.Rules` v=1 `list` with `type=allow|deny` AND `offset`/`limit`. Missing any param → 5100.
- **Port forwarding**: `SYNO.Core.PortForwarding.Rules` v=1 `load` (NOT `list`). Returns a bare array.
- **Package stop/start/restart**: `SYNO.Core.Package.Control` v=1 with `method=stop|start|restart`, POST, `id=<pkg>`.
- **Security Advisor scan**: `SYNO.Core.SecurityScan.Operation` v=1 `start` (POST, `items=ALL`) → poll `SYNO.Core.SecurityScan.Status` v=1 `system_get` until `sysProgress>=100` → fetch findings via `rule_get` (`items=ALL`).
- **QuickConnect state**: `SYNO.Core.QuickConnect` v=2 `get` for master toggle + alias; v=3 `get_misc_config` for `relay_enabled`.

## Version negotiation

Reference implementations ([N4S4/synology-api](https://github.com/N4S4/synology-api), [gaetangr/synaudit](https://github.com/gaetangr/synaudit), Home Assistant's [py-synologydsm-api](https://github.com/mib1185/py-synologydsm-api)) all query `SYNO.API.Info?query=all` once at startup and use `maxVersion` per API. This repo doesn't — every tool hardcodes the version it was developed against, because the alternative (negotiating per startup) added a cold-start round-trip and a class of "max version returns a shape this code doesn't understand" failures we'd rather catch via a HAR capture. If a future DSM bump breaks a hardcoded version, surface it as an explicit code change, not a silent floor shift.

## Form-encoding gotcha

For form-encoded params, DSM JSON-parses each value:

- Strings need quotes on the wire: `name="FileStation"` (use `JSON.stringify("FileStation")` in code)
- Bools, numbers, null: literal — `beta=false`, `version=2`, `task_id=null`
- Arrays/objects: JSON-stringified — `configs=[{"adapter":"eth0"}]`

This is why `tools/packages.ts` wraps string params in `JSON.stringify()` everywhere.

## Other reverse-engineered patterns

- **Docker image upload URL** (used by `Project.build` for tar imports): `/webapi/entry.cgi/SYNO.Docker.Image?api=SYNO.Docker.Image&method=upload&version=1` — the API name is embedded as a URL **path segment**, not just a query param. The multipart-form field carrying the file body is named `filename`. Required header: `X-SYNO-TOKEN` (mandatory on mutating `SYNO.Docker.*` and `SYNO.Core.Package.*` endpoints; without it you get code 119).
- **TOTP code reuse window**: DSM rejects the same TOTP code within ~30 seconds. The error is code 404 "Failed to authenticate 2-factor authentication code." Persist the post-login SID (e.g. via `DSM_SID_CACHE_FILE`) across rapid dev iteration so you don't burn a new code per process.
