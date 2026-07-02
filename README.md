# synology-mcp

MCP server for managing a Synology NAS (DSM 7). Exposes typed tools for package management, security audit, share inspection, and storage health. Designed to run as a container on the NAS itself, reachable from your Mac over Tailscale.

## What it does

- Read tools (safe to invoke): system status, storage/drive health, installed packages, available updates, package info, Security Advisor findings, users + 2FA state, firewall, DSM security settings, shares, external access (QuickConnect / DDNS / reverse proxy), certificates, notifications.
- Write tools (gated on user confirmation): install / uninstall / update a single package, plus start/stop/restart. Refuses DSM-self updates and kernel-flagged packages.
- Per-write audit log written to `/volume1/docker/synology-mcp/audit/YYYY-MM.jsonl`.

## What it does *not* do

- DSM self-update, firewall rule edits, 2FA policy changes, SMB protocol changes. These appear only as findings; apply manually via the DSM UI.

## Before you install

This server:
- Talks to DSM's Web API as a dedicated DSM user `claude-mcp` (must be in `administrators` because DSM 7 gates its admin APIs on that group; 2FA TOTP enforced, no shared-folder access, no SSH service — compensating controls documented in `docs/SETUP.md`).
- Reads its credentials at startup from a 1Password service-account-scoped item.
- Binds its HTTP endpoint to the `tailscale0` interface only — not LAN-reachable.
- Logs every mutating call to a local JSONL audit file.

Setup steps are in [`docs/SETUP.md`](docs/SETUP.md). Each step is discrete; uninstall reverses them in order.

## Footprint

| What | Where |
|---|---|
| Container image | DSM Container Manager, project `synology-mcp` |
| Container network | host networking; binds to tailscale0 only |
| HTTP port | 8765 (configurable) |
| Audit log | `/volume1/docker/synology-mcp/audit/YYYY-MM.jsonl` |
| DSM user | `claude-mcp` (admin group, 2FA, shared-folder access denied) |
| Secrets | 1Password item "Synology DSM - claude-mcp" (ASCII hyphen, not em-dash) |
| Outbound | localhost:5001 (DSM API) only |

## License

MIT. See [LICENSE](LICENSE).
