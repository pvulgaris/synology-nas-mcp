/**
 * Notification posture: SMTP / Push config + whether anyone will hear alarms.
 *
 * Security Advisor's `rule_notify_download_ready_v3` reliably flags when this
 * is broken, but the audit composition wants the underlying state so it can
 * distinguish "no SMTP at all" from "SMTP wired up but no recipients" from
 * "SMTP fine, just verify-cert is off."
 */

import type { SynoClient } from "../dsm.js";

export async function nasNotifications(dsm: SynoClient) {
  const mail = await dsm
    .call({ api: "SYNO.Core.Notification.Mail.Conf", method: "get", version: 1 })
    .catch(() => null);
  return {
    mail: mail
      ? {
          enabled: mail.enable_mail,
          oauth: mail.enable_oauth,
          smtp_server: mail.smtp_info?.server,
          smtp_port: mail.smtp_info?.port,
          ssl: mail.smtp_info?.ssl,
          verify_cert: mail.smtp_info?.verifyCert,
          sender: mail.sender_mail,
          subject_prefix: mail.subject_prefix,
          // `mail` is the recipient address list; if empty the SMTP path is
          // configured but no human ever gets the message.
          recipients_count: Array.isArray(mail.mail) ? mail.mail.length : null,
          in_use: mail.in_use ?? null,
        }
      : null,
  };
}
