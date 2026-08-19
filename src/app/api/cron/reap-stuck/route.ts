/**
 * GET /api/cron/reap-stuck — escalate cases stuck in `procesando`.
 *
 * Daily safety-net sweep for the Vercel `after()` eviction problem: when a big
 * simulate batch exceeds the function's wall-clock budget, later cases never get
 * their AI agent run and sit in `procesando` indefinitely. This transitions any
 * such case (older than SIMULATE_STUCK_REAP_AFTER_MS, default 20 min) to
 * `escalado` so it can be re-analyzed and so the simulation queue stays clear.
 *
 * Runs once daily (Hobby-plan safe — Hobby caps crons at once per day). The
 * primary, real-time mechanism is the opportunistic reaper call that simulate
 * and batch-simulate run synchronously before queuing a new batch; this cron is
 * just a backstop for when no new simulations run for a long stretch.
 *
 * Auth: Authorization: Bearer <CRON_SECRET> (constant-time compared), same as
 * the gmail-poll cron. Vercel cron invocations include this header automatically.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { reapStuckProcessingCases } from "@/server/intake/reap-stuck";
import { closeAbandonedConversations } from "@/server/intake/close-abandoned";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron/reap-stuck] CRON_SECRET is not configured"); // crew-debug-ok
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Server misconfiguration." } },
      { status: 500 }
    );
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  let isAuthorized = false;
  try {
    const expectedBuf = Buffer.from(expected, "utf-8");
    const actualBuf = Buffer.from(authHeader, "utf-8");
    if (expectedBuf.length === actualBuf.length) {
      isAuthorized = timingSafeEqual(expectedBuf, actualBuf);
    }
  } catch {
    isAuthorized = false;
  }

  if (!isAuthorized) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid or missing Authorization header." } },
      { status: 401 }
    );
  }

  const result = await reapStuckProcessingCases();

  // Same nightly pass, second sweep: conversations the claimant abandoned.
  // Piggybacking rather than adding a cron because the Hobby plan allows one
  // run a day and both jobs want exactly that cadence.
  const abandoned = await closeAbandonedConversations();

  return NextResponse.json({ ok: true, ...result, abandoned_closed: abandoned.closed });
}
