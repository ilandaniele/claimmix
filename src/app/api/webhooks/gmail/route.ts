/**
 * POST /api/webhooks/gmail — Google Cloud Pub/Sub push receiver.
 *
 * Pub/Sub delivers a push message by POSTing to this endpoint. The message
 * envelope contains a base64-encoded payload with { emailAddress, historyId }.
 * We decode the payload, then call pollGmail() to ingest any new emails.
 *
 * Security model:
 * - When PUBSUB_AUDIENCE is set: verify Google-issued OIDC token via
 *   OAuth2Client.verifyIdToken(). Only Google's Pub/Sub push service produces
 *   valid tokens for our specific audience URL.
 * - When PUBSUB_AUDIENCE is unset (local dev): skip OIDC verification; log a
 *   single startup warning per process. NEVER use this mode in production.
 *
 * AC4: PUBSUB_AUDIENCE unset → skip verify, call pollGmail, return 200 { ok: true }
 * AC5: PUBSUB_AUDIENCE set + no Authorization header → 401 MISSING_TOKEN
 * AC6: PUBSUB_AUDIENCE set + Bearer token that fails verifyIdToken → 401 INVALID_TOKEN
 * AC7: pollGmail throws → log error name, return 200 { ok: true, error: <name> } (ACK)
 * AC8: Missing message.data in envelope → 400 INVALID_ENVELOPE (not 200; this is
 *      a malformed message that Pub/Sub should not retry without operator intervention)
 *
 * Security note: No token contents, OIDC payload, message body, emailAddress,
 * historyId, or stack traces are included in responses or logs.
 * crew-debug-ok: console.error calls are annotated with // crew-debug-ok
 */

import { NextRequest, NextResponse } from "next/server";
import { OAuth2Client } from "google-auth-library";
import { createServiceClient } from "@/lib/supabase/service";
import { pollGmail } from "@/server/email/gmail/gmail-poller";
import { getGmailAccountByEmail } from "@/server/email/gmail/accounts";

/** Required: prevent Vercel from statically optimising this dynamic route. */
export const dynamic = "force-dynamic";

// ── Singleton OAuth2Client ────────────────────────────────────────────────────
//
// Created once per module lifecycle (cold start), only when PUBSUB_AUDIENCE is
// set. Avoids re-constructing the Google auth client on every request.

let _oidcClient: OAuth2Client | null = null;

function getOidcClient(): OAuth2Client | null {
  if (!process.env.PUBSUB_AUDIENCE) return null;
  if (!_oidcClient) {
    _oidcClient = new OAuth2Client();
  }
  return _oidcClient;
}

// ── Skip-verify startup warning (once per process) ────────────────────────────
//
// IC4: A single warning is emitted when the module first handles a request
// without PUBSUB_AUDIENCE. Subsequent requests are silent.

let _warnedSkipVerify = false;

function warnSkipVerifyOnce(): void {
  if (!_warnedSkipVerify) {
    _warnedSkipVerify = true;
    console.warn(
      "[webhooks/gmail] PUBSUB_AUDIENCE not set — OIDC verification skipped. " +
        "Set PUBSUB_AUDIENCE before exposing this endpoint in production."
    ); // crew-debug-ok
  }
}

// ── Pub/Sub envelope type ─────────────────────────────────────────────────────

interface PubSubEnvelope {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
}

interface GmailPushPayload {
  emailAddress?: string;
  historyId?: string;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const audience = process.env.PUBSUB_AUDIENCE;

  // ── OIDC verification (when PUBSUB_AUDIENCE is configured) ──────────────────
  if (audience) {
    const authHeader = request.headers.get("authorization") ?? "";

    if (!authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        {
          error: {
            code: "MISSING_TOKEN",
            message: "Authorization header with Bearer token is required.",
          },
        },
        { status: 401 }
      );
    }

    const bearerToken = authHeader.slice("Bearer ".length);
    const oidcClient = getOidcClient();

    try {
      // verifyIdToken validates: signature, expiry, issuer (accounts.google.com),
      // and audience. Throws if any check fails.
      await oidcClient!.verifyIdToken({
        idToken: bearerToken,
        audience,
      });
    } catch {
      // Do NOT log the token or the error message — they may contain token contents.
      // Only log the error name for debugging. crew-debug-ok
      console.error("[webhooks/gmail] OIDC token verification failed"); // crew-debug-ok
      return NextResponse.json(
        {
          error: {
            code: "INVALID_TOKEN",
            message: "Bearer token is invalid or has incorrect audience.",
          },
        },
        { status: 401 }
      );
    }
  } else {
    // Skip-verify mode: local dev or misconfigured production.
    warnSkipVerifyOnce();
  }

  // ── Parse and validate Pub/Sub envelope ─────────────────────────────────────

  let envelope: PubSubEnvelope;
  try {
    envelope = (await request.json()) as PubSubEnvelope;
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_ENVELOPE",
          message: "Request body is not valid JSON.",
        },
      },
      { status: 400 }
    );
  }

  const messageData = envelope?.message?.data;
  const messageId = envelope?.message?.messageId ?? "(unknown)";

  if (!messageData) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_ENVELOPE",
          message: "Missing message.data in Pub/Sub envelope.",
        },
      },
      { status: 400 }
    );
  }

  let pushPayload: GmailPushPayload = {};
  try {
    pushPayload = JSON.parse(Buffer.from(messageData, "base64").toString("utf8"));
  } catch {
    pushPayload = {};
  }

  // ── Trigger Gmail poll ───────────────────────────────────────────────────────
  //
  // We always ACK with 200 when pollGmail throws (IC3): retrying on non-2xx
  // would create a storm that hammers Vercel quotas. The daily cron fallback
  // and next push event will catch up.

  try {
    const supabase = createServiceClient();
    const connectedAccount = pushPayload.emailAddress
      ? await getGmailAccountByEmail(supabase, pushPayload.emailAddress)
      : null;
    const result = connectedAccount
      ? await pollGmail(supabase, {
          tenantId: connectedAccount.tenantId,
          email: connectedAccount.email,
          refreshToken: connectedAccount.refreshToken,
        })
      : await pollGmail(supabase);

    return NextResponse.json({ ok: true, result });
  } catch (err: unknown) {
    // Log error name + messageId only — never body, PII, or stack trace.
    const errName =
      (err as { name?: string })?.name ??
      (err as { code?: string })?.code ??
      "UnknownError";
    console.error(
      `[webhooks/gmail] pollGmail failed: ${errName} (messageId=${messageId})`
    ); // crew-debug-ok
    return NextResponse.json({ ok: true, error: errName });
  }
}
