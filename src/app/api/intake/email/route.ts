/**
 * /api/intake/email — Postmark inbound webhook endpoint (DEPRECATED).
 *
 * This route has been replaced by Gmail Push Notifications (feat/gmail-email-intake).
 * Returning 410 Gone for all HTTP methods so stale Postmark webhook retries
 * fail cleanly without injecting data.
 *
 * IC3: Keep the file (do not delete) to avoid breaking external monitors that
 * still hit this URL during the cutover period. The route does nothing except
 * return 410 — no HMAC verification, no Postmark parsing, no DB writes.
 *
 * AC11: Response is 410 with { error: { code: "GONE", message: "..." } }.
 */

import { NextResponse } from "next/server";

function goneResponse(): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: "GONE",
        message: "Postmark intake disabled; using Gmail Push Notifications",
      },
    },
    { status: 410 }
  );
}

export async function GET(): Promise<NextResponse> {
  return goneResponse();
}

export async function POST(): Promise<NextResponse> {
  return goneResponse();
}

export async function PUT(): Promise<NextResponse> {
  return goneResponse();
}

export async function PATCH(): Promise<NextResponse> {
  return goneResponse();
}

export async function DELETE(): Promise<NextResponse> {
  return goneResponse();
}
