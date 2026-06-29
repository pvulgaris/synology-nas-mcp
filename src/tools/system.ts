/**
 * System-level read tools: status, storage health.
 */

import type { SynoClient } from "../dsm.js";

// DSM returns up_time as a duration string ("HH:MM:SS" under 100h, or
// "N days HH:MM:SS" beyond). Parse to seconds so consumers can do math
// without depending on string parsing.
function parseUpTime(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = s.match(/^(?:(\d+)\s*days?\s+)?(\d+):(\d+):(\d+)$/);
  if (!m) return null;
  const [, days = "0", hours, minutes, seconds] = m;
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export async function nasStatus(dsm: SynoClient) {
  const [info, util] = await Promise.all([
    dsm.call({ api: "SYNO.Core.System", method: "info", version: 3 }),
    dsm.call({
      api: "SYNO.Core.System.Utilization",
      method: "get",
      version: 1,
    }).catch(() => null),
  ]);
  return {
    model: info?.model,
    serial: info?.serial,
    dsm_version: info?.firmware_ver,
    uptime: info?.up_time,
    uptime_seconds: parseUpTime(info?.up_time),
    temperature_c: info?.sys_temp,
    cpu_load: util?.cpu,
    memory: util?.memory,
    fan: info?.systempwarn,
  };
}

// Single-call alternative to SYNO.Core.Storage.Volume.list — returns volumes,
// disks, and storagePools in one shot. Used by HA's py-synologydsm-api and N4S4
// against DSM 7.x. The .Volume.list path requires SYNO.API.Info version
// negotiation; this one doesn't.
export async function nasStorageHealth(dsm: SynoClient) {
  const info = await dsm.call({
    api: "SYNO.Storage.CGI.Storage",
    method: "load_info",
    version: 1,
  });
  return {
    volumes: (info?.volumes ?? []).map((v: any) => ({
      id: v.id,
      status: v.status,
      fs: v.fs_type,
      size_total: Number(v.size?.total),
      size_used: Number(v.size?.used),
      device_type: v.device_type,
    })),
    drives: (info?.disks ?? []).map((d: any) => ({
      id: d.id,
      name: d.name,
      model: d.model,
      vendor: d.vendor,
      status: d.status,
      smart_status: d.smart_status,
      temp_c: d.temp,
      size: Number(d.size_total),
      disk_type: d.diskType,
    })),
    pools: (info?.storagePools ?? []).map((p: any) => ({
      deploy_path: p.deploy_path,
      disks: p.disks,
      pool_children: (p.pool_child ?? []).map((c: any) => ({ id: c.id, size: c.size })),
    })),
  };
}
