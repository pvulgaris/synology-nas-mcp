/**
 * Data-protection posture: are there backup tasks and snapshot schedules,
 * and is anything encrypted? The audit composition needs both halves —
 * snapshots protect against ransomware, backups protect against pool loss.
 *
 * Both Hyper Backup and Snapshot Replication ship as separate packages and
 * may not be installed. Surface "package not installed" explicitly rather
 * than silently returning empty arrays — those mean different things.
 */

import type { DsmClient } from "../dsm.js";

async function packageInstalled(dsm: DsmClient, packageId: string): Promise<boolean> {
  const data = await dsm
    .call<any>({ api: "SYNO.Core.Package", method: "list", version: 2 })
    .catch(() => null);
  const pkgs = data?.packages ?? [];
  return pkgs.some((p: any) => p?.id === packageId);
}

export async function nasDataProtection(dsm: DsmClient) {
  const [hyperBackupInstalled, snapshotReplicationInstalled] = await Promise.all([
    packageInstalled(dsm, "HyperBackup"),
    packageInstalled(dsm, "SnapshotReplication"),
  ]);

  const hyperBackupTasks = hyperBackupInstalled
    ? await dsm
        .call({ api: "SYNO.Backup.Task", method: "list", version: 1 })
        .catch(() => null)
    : null;

  const snapshotShares = snapshotReplicationInstalled
    ? await dsm
        .call({ api: "SYNO.Core.Share.Snapshot", method: "list", version: 2 })
        .catch(() => null)
    : null;

  return {
    hyper_backup: hyperBackupInstalled
      ? {
          installed: true,
          tasks: (hyperBackupTasks?.task_list ?? hyperBackupTasks?.tasks ?? []).map((t: any) => ({
            id: t.task_id ?? t.id,
            name: t.name,
            destination: t.target_id ?? t.destination,
            encryption: t.encryption ?? t.is_encrypt,
            last_status: t.status ?? t.last_status,
            last_success_time: t.last_success_time,
          })),
        }
      : { installed: false, _note: "Hyper Backup package not installed — no off-NAS backups" },
    snapshot_replication: snapshotReplicationInstalled
      ? {
          installed: true,
          snapshots: snapshotShares?.snapshots ?? [],
        }
      : {
          installed: false,
          _note: "Snapshot Replication package not installed — no scheduled snapshots or immutable retention",
        },
  };
}
