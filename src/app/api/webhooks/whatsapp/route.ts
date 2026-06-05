/**
 * POST /api/webhooks/whatsapp — inbound WhatsApp message receiver.
 *
 * This route accepts a normalized webhook payload and stores it as a WhatsApp
 * claim message. The bounded intake agent is scheduled with after() so the
 * webhook can ACK quickly while extraction continues in-process.
 *
 * Auth: Authorization: Bearer <WHATSAPP_WEBHOOK_SECRET>
 */

import { after, type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createWhatsAppIntake, runIntakeAgent } from "@/server/agents/intake-agent";

export const dynamic = "force-dynamic";

const WhatsAppWebhookSchema = z.object({
  from: z.string().min(3).max(100),
  body: z.string().min(1).max(50_000),
  provider_message_id: z.string().max(200).optional().nullable(),
  thread_id: z.string().max(200).optional().nullable(),
  tenant_id: z.string().uuid().optional(),
});

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function resolveTenantId(bodyTenantId?: string): string | null {
  return bodyTenantId ?? process.env.WHATSAPP_TENANT_ID ?? process.env.GMAIL_TENANT_ID ?? null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid WhatsApp webhook credentials." } },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
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

    after(async () => {
      try {
        await runIntakeAgent({
          caseId: stored.caseId,
          tenantId,
          source: "whatsapp",
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : "UnknownError";
        console.error("[webhooks/whatsapp] Agent error:", name, "case:", stored.caseId); // crew-debug-ok
      }
    });

    return NextResponse.json(
      {
        ok: true,
        case_id: stored.caseId,
        created: stored.created,
        status: "received",
      },
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
