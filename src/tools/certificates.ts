/**
 * Certificate inventory + expiry tracking.
 *
 * DSM stores each cert with a `valid_till` string in "MMM DD HH:MM:SS YYYY GMT"
 * format. We derive a numeric `days_until_expiry` so the audit composition can
 * threshold "warn at 30 days" without parsing the date itself.
 */

import type { SynoClient } from "../dsm.js";

function daysUntil(validTill: unknown): number | null {
  if (typeof validTill !== "string") return null;
  const t = Date.parse(validTill);
  if (isNaN(t)) return null;
  return Math.floor((t - Date.now()) / 86400000);
}

export async function nasCertificates(dsm: SynoClient) {
  const data = await dsm.call({
    api: "SYNO.Core.Certificate.CRT",
    method: "list",
    version: 1,
  });
  return {
    certificates: (data?.certificates ?? []).map((c: any) => ({
      id: c.id,
      desc: c.desc,
      common_name: c.subject?.common_name,
      issuer: c.issuer?.common_name,
      issuer_organization: c.issuer?.organization,
      alt_names: c.subject?.sub_alt_name ?? [],
      valid_from: c.valid_from,
      valid_till: c.valid_till,
      days_until_expiry: daysUntil(c.valid_till),
      is_default: c.is_default,
      is_broken: c.is_broken,
      renewable: c.renewable,
      self_signed: !!c.self_signed_cacrt_info,
      user_deletable: c.user_deletable,
      services: (c.services ?? []).map((s: any) => ({
        subscriber: s.subscriber,
        service: s.service,
        display_name: s.display_name,
      })),
    })),
  };
}
