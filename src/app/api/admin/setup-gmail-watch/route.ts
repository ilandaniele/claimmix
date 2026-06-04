/**
 * POST /api/admin/setup-gmail-watch — operator one-time setup endpoint.
 *
 * Registers a Gmail push subscription for the configured account by calling
 * setupGmailWatch() with the PUBSUB_TOPIC environment variable.
 *
 * Auth: Internal-only. Accepts either:
 *   a) X-Internal-Worker: true header (same-origin worker call)
 *   b) Authorization: Bearer <CRON_SECRET> header (Vercel cron / scheduled triggers)
 *
 * This endpoint is NOT user-facing — it should not be exposed publicly.
 * The proxy.ts (middleware) blocks unauthenticated requests to /api/admin/*
 * so this header check is defense-in-depth.
 *
 * W4: AC12, AC13, AC14, AC15.
 */

import { type NextRequest, NextResponse } from "next/server";
import { setupGmailWatch } from "@/server/email/gmail/watch";

/**
 * Verify the caller is an internal worker or Vercel cron.
 * Returns true if the request is authorized.
 */
function isAuthorized(request: NextRequest): boolean {
  // Option A: same-origin internal worker header.
  const internalHeader = request.headers.get("x-internal-worker");
  if (internalHeader === "true") return true;

  // Option B: Vercel cron secret.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader === `Bearer ${cronSecret}`) return true;
  }

  return false;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── Auth check ────────────────────────────────────────────────────────────────
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Acceso no autorizado." } },
      { status: 401 }
    );
  }

  // ── Env check ────────────────────────────────────────────────────────────────
  const topicName = process.env.PUBSUB_TOPIC;
  if (!topicName) {
    return NextResponse.json(
      {
        error: {
          code: "PUBSUB_TOPIC_MISSING",
          message: "Set PUBSUB_TOPIC env var to the fully-qualified Pub/Sub topic name (e.g. projects/my-project/topics/gmail-push).",
        },
      },
      { status: 500 }
    );
  }

  // ── Setup watch ──────────────────────────────────────────────────────────────
  try {
    const { historyId, expiration } = await setupGmailWatch(topicName);
    return NextResponse.json(
      {
        data: {
          historyId,
          expiration,
          message: "Gmail watch configured successfully.",
        },
      },
      { status: 200 }
    );
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : "Unknown error";
    const errName = err instanceof Error ? err.name : "UnknownError";
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "admin.setup_gmail_watch.failed",
        error_name: errName,
      })
    );
    return NextResponse.json(
      { error: { code: "WATCH_SETUP_FAILED", message: errMessage } },
      { status: 500 }
    );
  }
}
