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

import { timingSafeEqual } from "crypto";
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

  // Option B: Vercel cron secret — constant-time comparison to prevent timing oracle.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${cronSecret}`;
    try {
      // timingSafeEqual requires same-length buffers — encode both as UTF-8.
      const expectedBuf = Buffer.from(expected, "utf-8");
      const actualBuf = Buffer.from(authHeader, "utf-8");
      if (expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf)) {
        return true;
      }
    } catch {
      // length mismatch or encoding error — fall through to reject
    }
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
          code: "PUBSUB_NOT_CONFIGURED",
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
      { historyId, expiration, message: "watch setup OK" },
      { status: 200 }
    );
  } catch (err) {
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
      { error: { code: "INTERNAL", message: "Watch setup failed. Check server logs." } },
      { status: 500 }
    );
  }
}
