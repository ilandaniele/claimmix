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
 * A qué inquilino va cada evento de Meta lo decide `resolverNumeros`
 * (`@/server/whatsapp/numeros`) por el `phone_number_id` con que Meta lo firmó;
 * las credenciales del número (WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN,
 * WHATSAPP_TENANT_ID) se leen sólo ahí.
 *
 * Por el mismo camino firmado llegan también los avisos de la cuenta de cada cliente
 * (`account_update`, `phone_number_name_update`): no traen mensajes, hablan de la WABA
 * y los atiende `atenderEventosDeCuenta` después de contestar. El camino con Bearer
 * no los atiende: es de simulación y no habla con Meta.
 *
 * Env:
 *   WHATSAPP_VERIFY_TOKEN   — token echoed during the Meta GET handshake
 *   WHATSAPP_APP_SECRET     — Meta App Secret, validates the POST signature
 *   WHATSAPP_WEBHOOK_SECRET — Bearer secret for the normalized path
 */

import { after, type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { timingSafeStringEqual } from "@/lib/security/compare";
import { createWhatsAppIntake } from "@/server/agents/intake-agent";
import { logger } from "@/lib/observability/logger";
import { atenderEventosDeCuenta } from "@/server/alta/eventos-de-cuenta";
import { inquilinoDeLaPlataforma, resolverNumeros, type Destino } from "@/server/whatsapp/numeros";
import {
  parseCloudApiMessages,
  parseEventosDeCuenta,
  resolveWebhookChallenge,
  verifyMetaSignature,
} from "@/server/whatsapp/cloud-api";
import { atenderLoteDeMeta, scheduleAgent } from "@/server/whatsapp/webhook-de-meta";

export const dynamic = "force-dynamic";
// El `after()` corre con este mismo techo, contado desde que entra el pedido.
export const maxDuration = 300;

const WhatsAppWebhookSchema = z.object({
  from: z.string().min(3).max(100),
  body: z.string().min(1).max(50_000),
  provider_message_id: z.string().max(200).optional().nullable(),
  thread_id: z.string().max(200).optional().nullable(),

  /**
   * El nombre de perfil, para que el adaptador BSP y el ensayo puedan recorrer
   * el mismo camino que el webhook de Meta. Quien escribe lo elige y nadie lo
   * verifica: el juicio de si es el nombre de una persona está en
   * `@/core/nombres`, no acá.
   */
  name: z.string().max(200).optional().nullable(),
});

function hasBearer(request: NextRequest): boolean {
  const secret = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!secret) return false;
  return timingSafeStringEqual(request.headers.get("authorization"), `Bearer ${secret}`);
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
  // El reloj de Vercel corre desde acá, no desde el `after()`.
  const hasta = Date.now() + maxDuration * 1000;

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

    const messages = parseCloudApiMessages(payload);

    // Los avisos de la cuenta no esperan al ruteo de los mensajes ni demoran el acuse:
    // hablan con Graph y todos son idempotentes, así que una reentrega no rompe nada.
    const eventosDeCuenta = parseEventosDeCuenta(payload);
    if (eventosDeCuenta.length > 0) after(() => atenderEventosDeCuenta(eventosDeCuenta));

    // La firma dice que el evento viene de Meta, no a quién le hablaron: la app
    // puede estar suscripta a más de una WABA. Una sola consulta por pedido: de
    // quién es cada número que aparece en el lote.
    let destinos: Map<string, Destino>;
    try {
      const wabaDe = new Map<string, string>();
      for (const m of messages) {
        const numero = m.toPhoneNumberId?.trim();
        if (numero && m.toWabaId) wabaDe.set(numero, m.toWabaId);
      }
      destinos = await resolverNumeros(
        messages.flatMap((m) => (m.toPhoneNumberId?.trim() ? [m.toPhoneNumberId.trim()] : [])),
        wabaDe
      );
    } catch (err) {
      // Un 500 y no un descarte: Meta reintenta, y resolver "por las dudas" al
      // inquilino por omisión sería mandar la denuncia de otro a la bandeja de éste.
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "whatsapp.webhook.ruteo_failed");
      return NextResponse.json(
        { error: { code: "ROUTING_FAILED", message: "Could not resolve the destination number." } },
        { status: 500 }
      );
    }

    const respuesta = await atenderLoteDeMeta(messages, (numero) => destinos.get(numero), hasta);
    return NextResponse.json(respuesta.cuerpo, { status: respuesta.status });
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

  // De la configuración del deploy y nada más: el secreto es uno solo y global,
  // así que si el cuerpo pudiera elegir el inquilino, quien lo tenga escribiría
  // en la bandeja de cualquiera. Va siempre a la plataforma, nunca a una prueba.
  const tenantId = inquilinoDeLaPlataforma();
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
      senderName: parsed.data.name,
      // Simulation and BSP adapters invent their phone numbers. The case is
      // marked so the messenger records what it would have said instead of
      // sending it — messaging a made-up number is how a WhatsApp Business
      // account gets flagged.
      simulated: true,
    });
    // Igual que arriba: un adaptador que reintenta no dispara otra extracción,
    // y el que pasó el tope por remitente (E12) tampoco.
    if (!stored.duplicado && !stored.excedente) scheduleAgent([stored.caseId], tenantId, false, hasta);

    return NextResponse.json(
      { ok: true, case_id: stored.caseId, created: stored.created, status: "received" },
      { status: 202 }
    );
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    logger.error({ error_name: name }, "webhooks_whatsapp.intake_error");
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Could not process WhatsApp message." } },
      { status: 500 }
    );
  }
}

