/**
 * GET /api/cron/gmail-poll — Vercel cron endpoint for Gmail polling.
 *
 * Vercel cron invocations include: Authorization: Bearer <CRON_SECRET>
 * Direct calls must include the same header for security.
 *
 * AC1:  Calls pollGmail which ingests new messages into claim_messages.
 * AC6:  Missing or incorrect Authorization header → 401 (Gmail API never called).
 * AC13: Per-message errors are caught inside pollGmail; watermark only advances
 *       past successfully processed messages. Returns 200 with errors count.
 *
 * Security: CRON_SECRET compared with crypto.timingSafeEqual to prevent
 * timing oracle attacks (constant-time comparison).
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { pollGmail } from "@/server/email/gmail/gmail-poller";

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
  const authHeader = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;

  let isAuthorized = false;
  try {
    // timingSafeEqual requires same-length buffers — encode both as UTF-8.
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

  try {
    const supabase = createServiceClient();
    const result = await pollGmail(supabase);
    return NextResponse.json({ ok: true, ...result });
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
