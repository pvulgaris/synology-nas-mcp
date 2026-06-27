/**
 * Server-level instructions sent to the MCP client on connect. Short — the
 * detailed orientation lives in skills/synology/SKILL.md.
 */

export const SERVER_INSTRUCTIONS = `
Synology DSM NAS management. Read tools (status, packages list / check_updates / info,
dsm OS update check, security advisor scan, users, firewall, dsm settings, shares, storage
health) are safe to invoke freely. For "what needs updating across my NAS and router?" use
synology_update_digest — it aggregates DSM OS, NAS packages, and (if a router is configured)
SRM OS into one result; router_srm_os_check_update covers the router OS individually (SRM
exposes no package-update API). Write tools (nas_package_install / nas_package_uninstall /
nas_package_update) MUST be confirmed with the user explicitly ('yes', literal) before
calling — one package per turn. OS updates (DSM/SRM) are detect-only; apply via the DSM/SRM UI.

Hard refusals (server-side, will reject 4xx-style): updating DSM itself, updating kernel
packages, anything else not in the registered tool list. For findings that suggest
firewall / 2FA / SMB protocol changes, surface them with the DSM UI path; do not call.
`;
