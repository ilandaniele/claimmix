/**
 * GET /api/cron/gmail-poll - daily Gmail watch renewal and fallback poll.
 *
 * Primary intake is Gmail Push Notifications:
 *   Gmail -> Pub/Sub -> POST /api/webhooks/gmail -> pollGmail().
 *
 * This route stays on a Hobby-safe once-daily Vercel cron schedule to renew the
 * Gmail watch before it expires and to provide a low-frequency safety net.
 *
 * Vercel cron invocations include: Authorization: Bearer <CRON_SECRET>
 * Direct calls must include the same header for security.
 *
 * AC1:  Calls pollGmail which ingests new messages into claim_messages.
 * AC6:  Missing or incorrect Authorization header → 401 (Gmail API never called).
 * AC9:  watch_expiration within 24h AND PUBSUB_TOPIC set → setupGmailWatch called;
 *       response includes watch_renewed:true.
 * AC10: watch_expiration >24h away AND PUBSUB_TOPIC set → setupGmailWatch NOT called;
 *       response includes watch_renewed:false.
 * AC11: PUBSUB_TOPIC unset → skip watch renewal; response includes
 *       watch_renewed:false and watch_skipped_reason:'PUBSUB_TOPIC_UNSET'.
 * AC13: Per-message errors are caught inside pollGmail; watermark only advances
 *       past successfully processed messages. Returns 200 with errors count.
 *
 * Security: CRON_SECRET compared with crypto.timingSafeEqual to prevent
 * timing oracle attacks (constant-time comparison).
 */

import { NextRequest, NextResponse } from "next/server";
import { isInternalRequest } from "@/lib/security/internal-auth";
import { timingSafeEqual } from "crypto";
import { pollAllGmailAccounts } from "@/server/email/gmail/gmail-poller";
import { getWatchExpiration } from "@/server/email/gmail/poll-state";
import { setupGmailWatch } from "@/server/email/gmail/watch";
import { listEnabledGmailAccounts } from "@/server/email/gmail/accounts";

/** 24 hours in milliseconds — renew if the watch expires within this window. */
const RENEWAL_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Required: mark route as dynamic so Vercel doesn't statically optimize it. */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    console.error("[cron/gmail-poll] CRON_SECRET is not configured"); // crew-debug-ok
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Server misconfiguration." } },
      { status: 500 }
    );
  }

  // Constant-time comparison — prevents timing oracle attacks.
  /*
   * La comparación sale de `isInternalRequest`, que es este mismo
   * `timingSafeEqual` contra `Bearer ${CRON_SECRET}` escrito una sola vez.
   *
   * Lo que NO se centraliza es el 500 de arriba. Que falte el secreto es una
   * mala configuración del despliegue y no un llamador sin permiso, y la
   * diferencia está fijada por tests a propósito.
   */
  if (!isInternalRequest(req)) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid or missing Authorization header." } },
      { status: 401 }
    );
  }

  try {
    // ── Watch renewal (AC9, AC10, AC11) ──────────────────────────────────────
    // Renew the Gmail push subscription before polling so the next day's push
    // notifications continue to arrive uninterrupted.

    const pubsubTopic = process.env.PUBSUB_TOPIC;
    const connectedAccounts = await listEnabledGmailAccounts();
    const gmailEmail = process.env.GMAIL_USER_EMAIL;
    const renewalAccounts =
      connectedAccounts.length > 0
        ? connectedAccounts.map((account) => ({
            email: account.email,
            refreshToken: account.refreshToken,
          }))
        : gmailEmail
          ? [{ email: gmailEmail, refreshToken: undefined }]
          : [];

    let watchRenewed = false;
    let watchSkippedReason: string | undefined;

    if (!pubsubTopic) {
      // AC11: PUBSUB_TOPIC unset — skip renewal without error.
      console.info("[cron/gmail-poll] PUBSUB_TOPIC not set, skipping watch renewal"); // crew-debug-ok
      watchSkippedReason = "PUBSUB_TOPIC_UNSET";
    } else if (renewalAccounts.length === 0) {
      // GMAIL_USER_EMAIL is also required to look up the expiration row.
      console.info("[cron/gmail-poll] GMAIL_USER_EMAIL not set, skipping watch renewal"); // crew-debug-ok
      watchSkippedReason = "GMAIL_USER_EMAIL_UNSET";
    } else {
      for (const account of renewalAccounts) {
      // Check whether the current watch subscription is expiring soon.
      const expiration = await getWatchExpiration(account.email);

      const needsRenewal =
        expiration === null ||
        Date.now() + RENEWAL_THRESHOLD_MS > new Date(expiration).getTime();

      if (needsRenewal) {
        // AC9: expiration null or within 24h → renew.
        try {
          await setupGmailWatch(pubsubTopic, account);
          watchRenewed = true;
        } catch (watchErr: unknown) {
          // Non-fatal: log error name only (no PII, no stack), then continue to poll.
          const errName =
            (watchErr as { name?: string })?.name ?? "UNKNOWN";
          console.error("[cron/gmail-poll] Watch renewal failed:", errName); // crew-debug-ok
        }
      }
      }
      // AC10: expiration >24h away → skip renewal (watchRenewed stays false).
    }

    // ── Poll ─────────────────────────────────────────────────────────────────
    const result = await pollAllGmailAccounts();

    const watchPayload: Record<string, unknown> = { watch_renewed: watchRenewed };
    if (watchSkippedReason !== undefined) {
      watchPayload.watch_skipped_reason = watchSkippedReason;
    }

    return NextResponse.json({ ok: true, ...watchPayload, ...result });
  } catch (err: unknown) {
    // Log error code/name only — never PII, credentials, or stack traces.
    const code =
      (err as { code?: string })?.code ??
      (err as { name?: string })?.name ??
      "UNKNOWN";
    console.error("[cron/gmail-poll] Fatal error:", code); // crew-debug-ok
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Poll failed." } },
      { status: 500 }
    );
  }
}
