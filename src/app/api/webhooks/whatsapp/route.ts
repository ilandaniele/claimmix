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
import { reapStuckProcessingCases } from "@/server/intake/reap-stuck";
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

/**
 * Este mensaje, ¿es para el número que atendemos?
 *
 * La firma dice que el evento viene de Meta. NO dice a quién le hablaron: un
 * webhook es de la APP, y una app puede quedar suscripta a más de una WABA —
 * una segunda aseguradora, un número de prueba, uno viejo que nadie dio de
 * baja. Todos esos mensajes llegan acá, firmados y válidos.
 *
 * Y abajo el inquilino sale de `WHATSAPP_TENANT_ID`, que es una constante. O
 * sea que la denuncia de la otra aseguradora se guardaba en la bandeja de
 * ésta, con sus fotos y su DNI. Es exactamente lo que el aislamiento por
 * inquilino existe para impedir, entrando por la única puerta que no lo
 * miraba.
 *
 * Deja pasar cuando falta cualquiera de los dos lados, y eso es a propósito.
 * Sin `WHATSAPP_PHONE_NUMBER_ID` no hay con qué comparar; y si algún día Meta
 * deja de mandar `metadata`, ser estricto acá tiraría TODAS las denuncias en
 * vez de una. La comparación protege del número de más, no del payload raro.
 *
 * Un mensaje descartado no se reintenta: el evento está bien, el destinatario
 * no somos nosotros, y reintentarlo no lo va a cambiar.
 */
function esParaNuestroNumero(toPhoneNumberId: string | undefined): boolean {
  const nuestro = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!nuestro || !toPhoneNumberId) return true;
  return toPhoneNumberId.trim() === nuestro;
}

function resolveTenantId(bodyTenantId?: string): string | null {
  return bodyTenantId ?? process.env.WHATSAPP_TENANT_ID ?? process.env.GMAIL_TENANT_ID ?? null;
}

/**
 * Schedules the bounded intake agent after the response is flushed, then
 * answers the sender.
 *
 * The reply runs AFTER extraction on purpose: only then do we know whether this
 * is a claim at all and which documents are missing, which is the difference
 * between a useful message and a generic "recibimos tu mensaje".
 *
 * Answering is the orchestrator's job, not this route's. Three messages in a
 * row about the same crash still produce one reply: the extraction lease
 * serialises the runs, and the run that loses re-runs afterwards over the
 * whole conversation rather than answering its own fragment.
 */
function scheduleAgent(
  caseId: string,
  tenantId: string,
  /**
   * False para el camino simulado. Decide UNA cosa: si despues del agente se
   * pasa el barrido de casos trabados.
   */
  trafficoReal: boolean
): void {
  after(async () => {
    try {
      await runIntakeAgent({ caseId, tenantId, source: "whatsapp" });
    } catch (err) {
      const name = err instanceof Error ? err.name : "UnknownError";
      console.error("[webhooks/whatsapp] Agent error:", name, "case:", caseId); // crew-debug-ok
      return; // no extraction result — nothing worth saying to the claimant yet
    }

    // Nothing to send from here. The extraction worker runs the same
    // post-extraction orchestrator email uses, and that decides what to say
    // and says it — including on follow-up messages, which this path only ever
    // answered when they happened to create a new case.

    /*
     * ── Barrer trabados con el tráfico, no sólo con el reloj ────────────────
     *
     * El barredor promete correr cada quince minutos
     * (`.github/workflows/barrer-trabados.yml`). GitHub no cumple ese cron en
     * un repositorio público: el 2026-09-08 disparó 7 veces en todo el día
     * contra las 96 que corresponderían, con huecos de más de cinco horas. Un
     * caso trabado puede quedarse trabado media jornada.
     *
     * Los otros dos llamadores oportunistas son `simulate` y `batch-simulate`,
     * o sea caminos de administración: no corren cuando entra una denuncia de
     * verdad. Éste sí.
     *
     * Va DESPUÉS del agente y en el mismo `after()`: no le roba tiempo a la
     * respuesta del webhook, y si falla no arrastra nada — el barrido es
     * idempotente y el cron sigue existiendo como respaldo.
     */
    /*
     * El barrido NO corre en la simulacion.
     *
     * El ensayo de conversaciones (`pnpm rehearse`) entra por el camino con
     * Bearer y manda muchos mensajes seguidos. Con el barrido colgado de cada
     * uno, cada mensaje del ensayo sumaba una consulta sobre `cases` entera
     * contra la MISMA base, y el ensayo corre en paralelo con la prueba de
     * carga del post-deploy: la medicion terminaba midiendo, en parte, al
     * ensayo.
     *
     * Y ademas es lo correcto por si mismo: una conversacion inventada no es
     * motivo para correr mantenimiento de produccion.
     */
    if (!trafficoReal) return;

    try {
      const barridos = await reapStuckProcessingCases({ tenantId });
      if (barridos.reaped > 0) {
        console.warn(
          JSON.stringify({
            level: "warn",
            service: "claimmix",
            msg: "webhook.barrio_trabados",
            cuantos: barridos.reaped,
            nota: "Los encontró el tráfico, no el cron.",
          })
        );
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : "UnknownError";
      console.error("[webhooks/whatsapp] barrido error:", name); // crew-debug-ok
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
    let sinGuardar = 0;
    let deOtroNumero = 0;

    for (const msg of messages) {
      if (!esParaNuestroNumero(msg.toPhoneNumberId)) {
        deOtroNumero++;
        console.error(
          JSON.stringify({
            level: "error",
            service: "claimmix",
            msg: "whatsapp.webhook.numero_ajeno",
            to_phone_number_id: msg.toPhoneNumberId ?? null,
          })
        ); // crew-debug-ok
        continue;
      }
      try {
        const stored = await ingest(tenantId, msg);
        caseIds.push(stored.caseId);

        // Una reentrega no vuelve a correr el agente.
        //
        // La base ya frenaba el mensaje repetido, pero el aviso se perdía y
        // esto se llamaba igual: cada reintento de Meta era otra extracción
        // contra Vertex y un segundo mensaje al asegurado diciendo lo mismo.
        // Meta reintenta cuando el acuse tarda, y el acuse mide 2,9 s p95.
        if (!stored.duplicado) scheduleAgent(stored.caseId, tenantId, true);
      } catch (err) {
        sinGuardar++;
        // El mensaje del error, no su nombre: `insertWhatsAppMessage` se toma
        // el trabajo de meter el código de Postgres adentro y `err.name` es
        // siempre "Error". Y sin el teléfono, que es de la persona.
        console.error(
          JSON.stringify({
            level: "error",
            service: "claimmix",
            msg: "whatsapp.webhook.intake_failed",
            provider_message_id: msg.providerMessageId ?? null,
            error: err instanceof Error ? err.message : String(err),
          })
        ); // crew-debug-ok
      }
    }

    /*
     * Si algún mensaje no se guardó, esto NO es un 200.
     *
     * El `try` de arriba se tragaba el error y la ruta contestaba 200 igual:
     * un hipo de Neon durante un pico y esa denuncia no existía en ningún
     * lado, con Meta marcándola entregada y sin reintentarla nunca. Con el
     * número real, ese mensaje es de alguien que acaba de chocar.
     *
     * Devolver 500 hace que Meta reentregue el evento ENTERO, incluidos los
     * mensajes que sí entraron. Eso sólo es seguro por el `duplicado` de
     * arriba: sin él, cada reentrega volvía a correr el agente sobre los que
     * ya estaban. Las dos mitades van juntas o no van.
     */
    if (sinGuardar > 0) {
      return NextResponse.json(
        {
          error: {
            code: "INTAKE_FAILED",
            message: "Some messages could not be stored.",
          },
        },
        { status: 500 }
      );
    }

    // 200 para un evento bien firmado que se guardó entero —incluidos los de
    // estado y lectura, que no traen mensajes— para que Meta lo marque
    // entregado y deje de reintentar.
    return NextResponse.json(
      {
        ok: true,
        received: caseIds.length,
        case_ids: caseIds,
        ...(deOtroNumero > 0 ? { ignored_other_number: deOtroNumero } : {}),
      },
      { status: 200 }
    );
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
      senderName: parsed.data.name,
      // Simulation and BSP adapters invent their phone numbers. The case is
      // marked so the messenger records what it would have said instead of
      // sending it — messaging a made-up number is how a WhatsApp Business
      // account gets flagged.
      simulated: true,
    });
    // Igual que arriba: un adaptador que reintenta no dispara otra extracción.
    if (!stored.duplicado) scheduleAgent(stored.caseId, tenantId, false);

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
    media: msg.media,
    // Ya se parseaba y se tiraba acá: el agente no sabía con quién hablaba y
    // le pedía el nombre a alguien que lo trae en el sobre.
    senderName: msg.name ?? null,
  });
}
