# Setup

Pre-reqs you do once. Most are clickthrough in DSM; the only command-line work is the final container build.

## 1. DSM packages

In DSM → Package Center, install:

- **Container Manager** (Synology's Docker frontend).
- **Tailscale** (official Synology package). Sign in to your tailnet. On DSM the package runs userspace-networking (there is no kernel `tailscale0` interface), so the MCP daemon binds **loopback** and is reached over the tailnet via `tailscale serve` — see "Network model" below.

## 2. Dedicated DSM user

DSM → Control Panel → User & Group → Create.

| Setting | Value |
|---|---|
| Username | `claude-mcp` |
| Description | "MCP server account; managed by 1Password" |
| Email | (leave blank) |
| Password | strong random, captured into 1Password (next step) |
| Disallow password change | yes |
| Password never expires | yes |
| Application permissions (wizard) | Allow: DSM only. Deny: File Station, AFP, FTP, SFTP, SMB, rsync, Audio Station, Universal Search |
| Shared folder permissions | No Access on every share (override `homes` explicitly) |
| User group | `users` **and** `administrators` (see "Why administrators" below) |
| 2-Factor Authentication | enable; capture the TOTP **secret** (base32 string, not the 6-digit code) to 1Password |
| Speed limit | leave default |

### Why `administrators`

DSM 7's admin apps — Package Center, Security Advisor, Control Panel, Resource Monitor — and their corresponding APIs (`SYNO.Core.Package.*`, `SYNO.SecurityAdvisor.*`, etc.) are gated by `administrators` group membership. There is no built-in mechanism to grant a non-admin user selective access to those apps; DSM's "Application Privileges" page (Control Panel → Application Privileges) lists only end-user services like File Station / SMB / AFP, not the admin apps.

So the user has to be an admin. To bound the blast radius:

1. **Password lives only in 1Password.** Generate it via DSM's "Generate Random Password" button, capture into the 1Password item, never type it by hand. There is no manual-login workflow for this account.
2. **2FA TOTP enforced.** Even with the password, no DSM (or SSH) login without the TOTP code.
3. **Disable SSH globally** unless you actively need it: Control Panel → Terminal & SNMP → uncheck "Enable SSH service." Admin group implies SSH eligibility; if the service is off, no one can use it.
4. **Deny all file-protocol access** in Application Privileges (above).
5. **No shared-folder permissions** — even with admin, this account has no readable filesystem presence.
6. **Tailscale ACL** restricts the MCP port (and 5001/22 if you leave them on) to your own tailnet devices.
7. **Bearer token + Origin check** on the MCP endpoint itself — an attacker who somehow got a DSM SID still can't drive :8765 without the wire token.

Residual risk: full DSM compromise if (1Password vault leaks) AND (Tailscale device key leaks) AND (you re-enabled SSH). Acceptable for personal use; document the controls so future-you knows what's load-bearing.

## 3. 1Password item + service account

In 1Password:

1. Create item **"Synology DSM - claude-mcp"** in a vault you don't share. Use only ASCII hyphens (`-`), not em-dashes (`—`) — the `op read` CLI rejects em-dashes in secret references. Fields:
   - `password` — the DSM password set above
   - `totp` — the TOTP **secret** (not a generated code; the raw base32 string DSM showed when you enabled 2FA)
   - `mcp_bearer_token` — generate a random 32-byte hex string: `openssl rand -hex 32`
2. Create a **service account** scoped read-only to the vault containing that item. Capture the service account token; you'll set it as `OP_SERVICE_ACCOUNT_TOKEN` on the container project.

## 4. Tailscale ACL

In the Tailscale admin console → Access Controls, restrict TCP :8765 on the NAS so only your Mac(s) and phone can hit it:

```jsonc
"acls": [
  // ... your existing rules ...
  {
    "action": "accept",
    "src":    ["<your-user-tag-or-email>"],
    "dst":    ["nas.local:8765"]
  }
]
```

If your tailnet uses the default open ACL ("everyone can talk to everyone"), add a `tag:nas` and restrict `*` → `tag:nas:*` so only your devices reach the NAS.

### Network model: loopback bind + `tailscale serve`

The daemon binds **loopback only** (`127.0.0.1:8765`) and is reached over the tailnet via the host's Tailscale `serve` proxy. This closes the LAN at the socket layer: a device on your home network gets connection-refused on `:8765` because nothing is bound to the NAS's LAN IP. The only thing that can reach the daemon is the host `tailscaled` (the daemon is on loopback), and it only accepts tailnet traffic. The bearer token + Origin check still run behind serve, so the controls stack: tailnet membership → serve → bearer → Origin.

Set up:

1. In the NAS `.env` (step 6), set `MCP_BIND_HOST=127.0.0.1`.
2. On the NAS, point Tailscale `serve` at the daemon — one-time; it persists in tailscaled state across reboots:

   ```sh
   sudo tailscale serve --bg --https=443 http://127.0.0.1:8765
   ```

   Requires HTTPS certificates enabled for your tailnet (admin console → DNS → Enable HTTPS) — **not** Funnel, which is public-internet ingress; leave it off. Confirm with `tailscale serve status` (and `tailscale funnel status`): both should read `(tailnet only)`.

Clients then use the serve URL `https://<your-nas>.<your-tailnet>.ts.net/mcp` (real cert, HTTPS) instead of `http://<nas>:8765/mcp`.

Why this rather than binding the tailnet IP directly: in userspace-networking mode there is no `tailscale0` to bind — but that same mode forwards inbound tailnet connections to localhost, so both `tailscale serve` (`:443`) and the tailnet IP on `:8765` reach the loopback daemon, while the LAN cannot reach either.

## 5. Optional but useful: DSM notification email

DSM → Control Panel → Notification → Email — point at your Gmail account. When packages have updates, DSM emails you. Set up a Gmail filter to label those messages (e.g., `synology/updates`) so Claude can find them via the Gmail MCP tools.

## 6. Container deploy (Project mode, recommended)

Use Container Manager's **Project** feature, not Container. Project mode reads
`docker-compose.yml` + `.env` from a directory on the NAS, so upgrades are
"swap the image and click Rebuild" — env vars persist on disk.

### One-time setup

1. Build the image locally on your Mac (cross-build to linux/amd64 for x86_64 Synology models; use `linux/arm64` on ARM models):

   ```sh
   cd <repo>
   docker build --platform linux/amd64 -t synology-nas-mcp:latest .
   docker save synology-nas-mcp:latest -o ~/Downloads/synology-nas-mcp-latest.tar
   ```

   (If you don't have Docker: `brew install colima docker && colima start` first.)

2. Prepare the NAS directory. DSM → File Station → `/volume1/docker/`. Create folder `synology-nas-mcp`. Inside it, create folder `audit`. Upload three files into `synology-nas-mcp/`:
   - The image tar from step 1 (`synology-nas-mcp-latest.tar`).
   - `docker-compose.yml` — copy of `synology.compose.yml` from this repo, renamed.
   - `.env` — copy of `.env.example` with your real values filled in. **Set strict perms** afterwards: `chmod 600 .env` (SSH in or use a Task Scheduler one-shot script). Contains the 1Password service-account token.

3. Import the image. DSM → Container Manager → **Image** → Add → Add from file → select the tar. Verify `synology-nas-mcp:latest` (and `:version`) appear.

4. Create the project. DSM → Container Manager → **Project** → **Create**:
   - Project name: `synology-nas-mcp`
   - Path: `/volume1/docker/synology-nas-mcp`
   - Source: **Use existing docker-compose.yml**
   - Click **Next** → review → **Done**. Project will start.

### Upgrades

```sh
docker build --platform linux/amd64 -t synology-nas-mcp:<ver> -t synology-nas-mcp:latest .
docker save synology-nas-mcp:<ver> synology-nas-mcp:latest -o ~/Downloads/synology-nas-mcp-<ver>.tar
source dev/source-creds.sh   # once per shell; keychain-cached (no TTL)
npm run deploy                # imports image → stops+builds+starts project → polls /health
```

Total wall time on Tailscale: ~30 seconds, most of it the 60 MB tar upload.

`npm run deploy` walks the DSM Web API end-to-end:

1. POST the tar to `/webapi/entry.cgi/SYNO.Docker.Image?api=…&method=upload&version=1` (the chunked-upload URL pattern the Container Manager UI uses; multipart-form field name is `filename`, X-SYNO-TOKEN header required). DSM imports the tar straight into its local Docker registry — no FileStation, no on-disk staging, no shared-folder ACL involved.
2. `SYNO.Docker.Project.list` to look up the project UUID by name.
3. `SYNO.Docker.Project.stop` → `Project.build` → `Project.start` to recycle the container with the freshly-imported `:latest`.
4. Poll `/health` until the response body's `version` matches `package.json`'s (bails after 120 seconds). Defaults to `http://<nas>:8765/health`; with the loopback + serve model, set `MCP_HEALTH_URL=https://<your-nas>.<your-tailnet>.ts.net/health` (e.g. in `dev/.env.local`) so the poll goes through serve instead of the now-closed direct port.

Exits non-zero on any step failure with a precise reason. No additional DSM permissions are required beyond what claude-mcp already has (administrators group, which it joined during setup).

To use a separate admin identity for deploys (e.g. keep claude-mcp's runtime token completely separate from deploy auth), set `DSM_DEPLOY_USER`, `DSM_DEPLOY_PASSWORD`, and `DSM_DEPLOY_TOTP_SECRET` env vars before `npm run deploy`.

Manual fallback (no script needed): import the tar via Container Manager UI → click Project → Action → Build. Same outcome, six clicks instead of one command.

## 7. Verify

From a Mac on the tailnet, hit the serve URL (read the bearer via `op read "op://<vault>/Synology DSM - claude-mcp/mcp_bearer_token"`):

```sh
TOKEN=$(op read "op://<vault>/Synology DSM - claude-mcp/mcp_bearer_token")
curl -i https://<your-nas>.<your-tailnet>.ts.net/health
# expect: 200 OK {"ok":true,"server":"synology-nas-mcp","version":"..."}

curl -i -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     https://<your-nas>.<your-tailnet>.ts.net/mcp
# expect: a tools list including nas_status, nas_packages_list, ...
```

Confirm the LAN is closed: from a device that can reach the NAS's LAN IP, `curl http://<nas-lan-ip>:8765/health` should be **connection-refused** — the daemon binds no LAN-facing socket. (`http://<nas>:8765` over the *tailnet* still works — tailscaled forwards it to the loopback daemon — and is bearer-gated like serve.) A tailnet device not in the ACL allowlist is blocked at the ACL layer.

## 8. Wire up the local bridge (Claude Desktop only)

Claude Desktop currently only accepts stdio MCP entries, not HTTP. Install the package's `bridge` subcommand globally on your Mac — it's a 39-line stdio→HTTP proxy that lives at `/opt/homebrew/bin/synology-nas-mcp`.

```sh
cd <repo>
npm install -g .
```

This builds + copies the package to `/opt/homebrew/lib/node_modules/synology-nas-mcp/` (a stable snapshot — edits to the repo don't propagate until you re-run `npm install -g .`).

After meaningful code changes, re-run `npm install -g .` to update the global install.

## 9. Wire up Claude

`~/Library/Application Support/Claude/claude_desktop_config.json` — add under `mcpServers`:

```json
"synology": {
  "command": "/opt/homebrew/bin/synology-nas-mcp",
  "args": ["bridge"],
  "env": {
    "MCP_BRIDGE_URL": "https://<your-nas>.<your-tailnet>.ts.net/mcp",
    "MCP_BRIDGE_TOKEN": "<paste bearer token here>"
  }
}
```

Claude Code CLI (one Mac):
```sh
TOKEN=$(op read "op://<vault>/Synology DSM - claude-mcp/mcp_bearer_token")
claude mcp add synology https://<your-nas>.<your-tailnet>.ts.net/mcp --header "Authorization: Bearer $TOKEN"
```

Restart Claude Desktop / Claude Code. Tools `mcp__synology__*` should appear.

## Uninstall, in reverse

To remove the integration completely:

1. Remove the `synology` entry from `claude_desktop_config.json` and any Claude Code MCP registration (`claude mcp remove synology`).
2. Container Manager → stop + delete the `synology-nas-mcp` project.
3. `rm -rf /volume1/docker/synology-nas-mcp` (this deletes the audit log too — copy it out first if you want to keep it).
4. Tailscale ACL → remove the `:8765` rule you added.
5. DSM → Control Panel → User & Group → delete `claude-mcp`.
6. 1Password → delete the item and revoke the service account.
