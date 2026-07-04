/**
 * WhatsApp inbound webhook — supports two authentication paths:
 *
 * 1. **Meta WhatsApp Business Cloud API (official, ban-safe)** — the production
 *    path. Meta sends a GET verification handshake when you register the callback
 *    URL, then POSTs message events signed with X-Hub-Signature-256 (HMAC of the
 *    raw body, keyed by the App Secret). Customers message your business number;
 *    Meta delivers the message here; we create a case and run the AI agent.
 *
 * 2. **Normalized + Bearer** — a simple `{ from, body, ... }` payload authorized
 *    with `Authorization: Bearer <WHATSAPP_WEBHOOK_SECRET>`. Kept for internal
 *    simulation, tests, and custom BSP adapters.
 *
 * Either way the message flows into the same intake pipeline
 * (createWhatsAppIntake → runIntakeAgent) that the email channel uses.
 *
 * Env:
 *   WHATSAPP_VERIFY_TOKEN   — token echoed during the Meta GET handshake
 *   WHATSAPP_APP_SECRET     — Meta App Secret, validates the POST signature
 *   WHATSAPP_ACCESS_TOKEN   — Cloud API token for outbound acknowledgements
 *   WHATSAPP_PHONE_NUMBER_ID— Cloud API sender phone-number id
 *   WHATSAPP_WEBHOOK_SECRET — Bearer secret for the normalized path
 *   WHATSAPP_TENANT_ID      — fallback tenant for inbound messages
 */

import { after, type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { timingSafeStringEqual } from "@/lib/security/compare";
import { createWhatsAppIntake, runIntakeAgent } from "@/server/agents/intake-agent";
import {
  parseCloudApiMessages,
  resolveWebhookChallenge,
  verifyMetaSignature,
  type NormalizedWhatsAppMessage,
} from "@/server/whatsapp/cloud-api";

export const dynamic = "force-dynamic";

const WhatsAppWebhookSchema = z.object({
  from: z.string().min(3).max(100),
  body: z.string().min(1).max(50_000),
  provider_message_id: z.string().max(200).optional().nullable(),
  thread_id: z.string().max(200).optional().nullable(),
  tenant_id: z.string().uuid().optional(),
});

function hasBearer(request: NextRequest): boolean {
  const secret = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!secret) return false;
  return timingSafeStringEqual(request.headers.get("authorization"), `Bearer ${secret}`);
}

function resolveTenantId(bodyTenantId?: string): string | null {
  return bodyTenantId ?? process.env.WHATSAPP_TENANT_ID ?? process.env.GMAIL_TENANT_ID ?? null;
}

/** Schedules the bounded intake agent after the response is flushed. */
function scheduleAgent(caseId: string, tenantId: string): void {
  after(async () => {
    try {
      await runIntakeAgent({ caseId, tenantId, source: "whatsapp" });
    } catch (err) {
      const name = err instanceof Error ? err.name : "UnknownError";
      console.error("[webhooks/whatsapp] Agent error:", name, "case:", caseId); // crew-debug-ok
    }
  });
}

// ── GET: Meta webhook verification handshake ─────────────────────────────────

export function GET(request: NextRequest): NextResponse {
  const challenge = resolveWebhookChallenge(request.nextUrl.searchParams);
  if (challenge === null) {
    return NextResponse.json(
      { error: { code: "VERIFICATION_FAILED", message: "Invalid verify token." } },
      { status: 403 }
    );
  }
  // Meta expects the raw challenge string echoed back as text/plain.
  return new NextResponse(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

// ── POST: inbound messages ───────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Read the raw body once — required for HMAC signature validation. Parsing
  // then re-serializing would change bytes and break the signature check.
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  // ── Path 1: Meta Cloud API (signature present) ──────────────────────────────
  if (signature) {
    if (!verifyMetaSignature(rawBody, signature)) {
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid webhook signature." } },
        { status: 401 }
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { error: { code: "INVALID_PAYLOAD", message: "Request body must be valid JSON." } },
        { status: 400 }
      );
    }

    const tenantId = resolveTenantId();
    if (!tenantId) {
      // ACK anyway (200) so Meta does not retry indefinitely; log the misconfig.
      console.error("[webhooks/whatsapp] WHATSAPP_TENANT_ID not configured"); // crew-debug-ok
      return NextResponse.json({ ok: true, ignored: "tenant_not_configured" }, { status: 200 });
    }

    const messages = parseCloudApiMessages(payload);
    const caseIds: string[] = [];
    for (const msg of messages) {
      try {
        const stored = await ingest(tenantId, msg);
        caseIds.push(stored.caseId);
        scheduleAgent(stored.caseId, tenantId);
      } catch (err) {
        const name = err instanceof Error ? err.name : "UnknownError";
        console.error("[webhooks/whatsapp] Intake error:", name, "from:", msg.from); // crew-debug-ok
      }
    }

    // Always 200 for a validly-signed event (incl. status/read events with no
    // messages) so Meta marks it delivered and stops retrying.
    return NextResponse.json({ ok: true, received: caseIds.length, case_ids: caseIds }, { status: 200 });
  }

  // ── Path 2: normalized + Bearer (simulation / BSP adapters) ──────────────────
  if (!hasBearer(request)) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid WhatsApp webhook credentials." } },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_PAYLOAD", message: "Request body must be valid JSON." } },
      { status: 400 }
    );
  }

  const parsed = WhatsAppWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid WhatsApp webhook payload.",
          details: parsed.error.flatten(),
        },
      },
      { status: 400 }
    );
  }

  const tenantId = resolveTenantId(parsed.data.tenant_id);
  if (!tenantId) {
    return NextResponse.json(
      { error: { code: "TENANT_NOT_CONFIGURED", message: "WhatsApp tenant is not configured." } },
      { status: 500 }
    );
  }

  try {
    const stored = await createWhatsAppIntake({
      tenantId,
      from: parsed.data.from,
      body: parsed.data.body,
      providerMessageId: parsed.data.provider_message_id,
      threadId: parsed.data.thread_id,
    });
    scheduleAgent(stored.caseId, tenantId);

    return NextResponse.json(
      { ok: true, case_id: stored.caseId, created: stored.created, status: "received" },
      { status: 202 }
    );
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    console.error("[webhooks/whatsapp] Intake error:", name); // crew-debug-ok
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Could not process WhatsApp message." } },
      { status: 500 }
    );
  }
}

/** Maps a normalized Cloud API message into the shared intake pipeline. */
function ingest(tenantId: string, msg: NormalizedWhatsAppMessage) {
  return createWhatsAppIntake({
    tenantId,
    from: msg.from,
    body: msg.body,
    providerMessageId: msg.providerMessageId,
    threadId: msg.from, // thread per sender phone number
  });
}
