/**
 * Shared-folder inspection.
 *
 * SYNO.Core.Share — list with additional fields. DSM 7 returns the additional[]
 * fields FLAT on each share object (not nested under `.additional`), and uses
 * `enable_recycle_bin` (not `recyclebin`) on the read side even though the
 * request additional[] key is `recyclebin`. Quota lives in `quota_value` /
 * `share_quota_used`, both in MB.
 */

import type { SynoClient } from "../dsm.js";

export async function nasSharesList(dsm: SynoClient) {
  const data = await dsm.call({
    api: "SYNO.Core.Share",
    method: "list",
    version: 1,
    params: {
      shareType: "all",
      additional:
        '["hidden","encryption","is_aclmode","unite_permission","is_support_acl","is_sync_share","is_force_readonly","force_readonly_reason","recyclebin","share_quota","enable_share_cow","enable_share_compress","support_snapshot"]',
    },
  });
  return {
    shares: (data?.shares ?? []).map((s: any) => ({
      name: s.name,
      vol_path: s.vol_path,
      enabled: !s.disable,
      encryption: s.encryption,
      hidden: s.hidden,
      quota_mb: s.quota_value,
      quota_used_mb: s.share_quota_used,
      recycle_bin: s.enable_recycle_bin,
      recycle_bin_admin_only: s.recycle_bin_admin_only,
      btrfs_cow: s.enable_share_cow,
      support_snapshot: s.support_snapshot,
      force_readonly: s.is_force_readonly,
      description: s.desc,
      uuid: s.uuid,
    })),
  };
}
