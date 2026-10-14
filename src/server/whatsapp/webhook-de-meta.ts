/**
 * Lo que los dos webhooks de Meta hacen igual con los mensajes de un lote ya
 * firmado y ruteado: guardarlos y correr el agente. El de la plataforma
 * (`api/webhooks/whatsapp`) y el de cada app propia (`.../app/[ruta]`) difieren
 * en cómo prueban la firma y en cómo deciden de quién es cada número, no en
 * esto.
 *
 * No importa `numeros.ts`: quién es el dueño de cada número lo resuelve el que
 * llama y llega acá como `tenantDe`.
 */

import { after } from "next/server";
import { createWhatsAppIntake, runIntakeAgent } from "@/server/agents/intake-agent";
import { reapStuckProcessingCases } from "@/server/intake/reap-stuck";
import {
  marcarPendientes,
  MINIMO_PARA_RETOMAR_MS,
  retomarExtraccionesPendientes,
} from "@/server/intake/retomar-pendientes";
import { logger } from "@/lib/observability/logger";
import type { NormalizedWhatsAppMessage } from "@/server/whatsapp/cloud-api";

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
 *
 * Un `after()` para todos los casos del pedido, no uno por caso: corren en
 * serie con el mismo reloj de la invocación. Lo que no entra se marca
 * pendiente en vez de arrancarse a mitad de camino y que lo mate Vercel.
 */
export function scheduleAgent(
  caseIds: string[],
  tenantId: string,
  /**
   * False para el camino simulado. Decide UNA cosa: si despues del agente se
   * pasa el barrido de casos trabados.
   */
  trafficoReal: boolean,
  /** Cuándo mata Vercel esta invocación (epoch ms). */
  hasta: number
): void {
  if (caseIds.length === 0) return;

  after(async () => {
    // Marcados antes de empezar, no al quedarse sin reloj: si Vercel mata la
    // invocación a mitad del primero, los demás igual quedan para el barrido.
    // Tomar la reserva limpia la marca de cada uno cuando le toca.
    await marcarPendientes(caseIds.slice(1), tenantId);
    for (let i = 0; i < caseIds.length; i++) {
      if (i > 0 && hasta - Date.now() < MINIMO_PARA_RETOMAR_MS) {
        logger.warn({ quedaron: caseIds.length - i }, "webhooks_whatsapp.sin_tiempo");
        break;
      }
      try {
        await runIntakeAgent({ caseId: caseIds[i], tenantId, source: "whatsapp", hasta });
      } catch (err) {
        const name = err instanceof Error ? err.name : "UnknownError";
        logger.error({ error_name: name, case_id: caseIds[i] }, "webhooks_whatsapp.agent_error");
      }
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
        logger.warn({
        cuantos: barridos.reaped,
        nota: "Los encontró el tráfico, no el cron.",
      }, "webhook.barrio_trabados");
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : "UnknownError";
      logger.error({ error_name: name }, "webhooks_whatsapp.barrido_error");
    }

    /*
     * Y lo que quedó marcado como pendiente y sin hacer.
     *
     * El cron nocturno también lo barre, pero en Hobby corre una vez por día y
     * el de GitHub Actions dispara siete veces de noventa y seis. El tráfico de
     * verdad es el único planificador confiable que hay.
     *
     * Con tope de DOS y con el reloj de esta invocación: cada retomado es una
     * corrida entera y comparte el techo de la función con la del mensaje que
     * acaba de llegar, que va primero. `hasta` hace que no se empiece uno que
     * ya no entra.
     */
    try {
      const retomados = await retomarExtraccionesPendientes({ tenantId, limit: 2, hasta });
      if (retomados.retomados > 0) {
        logger.warn({
        cuantos: retomados.retomados,
        nota: "Los encontró el tráfico, no el cron.",
      }, "webhook.retomo_pendientes");
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : "UnknownError";
      logger.error({ error_name: name }, "webhooks_whatsapp.retomar_pendientes_error");
    }
  });
}

/** Maps a normalized Cloud API message into the shared intake pipeline. */
export function ingest(tenantId: string, msg: NormalizedWhatsAppMessage) {
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

export interface ResultadoDelLote {
  status: 200 | 500;
  cuerpo: Record<string, unknown>;
}

/**
 * Guarda los mensajes de un lote de Meta ya firmado y programa el agente.
 *
 * `tenantDe` decide de quién es el número al que le hablaron; `undefined` es un
 * evento bien firmado cuyo destinatario no es de nadie: se descarta y no se
 * reintenta.
 */
export async function atenderLoteDeMeta(
  mensajes: NormalizedWhatsAppMessage[],
  tenantDe: (phoneNumberId: string) => string | undefined,
  hasta: number
): Promise<ResultadoDelLote> {
  const caseIds: string[] = [];
  // Junta casos, no mensajes: dos mensajes del mismo remitente en el mismo
  // pedido caen en el mismo caso, y el agente corre una vez por caso. Un
  // pedido puede traer mensajes de más de un inquilino: un agente por cada uno.
  const paraElAgente = new Map<string, Set<string>>();
  let sinGuardar = 0;
  let descartados = 0;

  for (const msg of mensajes) {
    const numero = msg.toPhoneNumberId?.trim();
    const tenantId = numero ? tenantDe(numero) : undefined;
    if (!tenantId) {
      // Sin metadata, de un número sin fila conectada o de uno suspendido: no
      // se reintenta, el evento está bien y el destinatario no es de nadie.
      descartados++;
      logger.error({
        to_phone_number_id: numero ?? null,
      }, "whatsapp.webhook.numero_desconocido");
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
      // Meta reintenta cuando el acuse tarda, y el acuse mide 2,9 s p95. Y el
      // que pasó el tope por remitente (E12) tampoco: se guardó y no se lee.
      if (!stored.duplicado && !stored.excedente) {
        const casos = paraElAgente.get(tenantId) ?? new Set<string>();
        casos.add(stored.caseId);
        paraElAgente.set(tenantId, casos);
      }
    } catch (err) {
      sinGuardar++;
      // El mensaje del error, no su nombre: `insertWhatsAppMessage` se toma
      // el trabajo de meter el código de Postgres adentro y `err.name` es
      // siempre "Error". Y sin el teléfono, que es de la persona.
      logger.error({
        provider_message_id: msg.providerMessageId ?? null,
        error: err instanceof Error ? err.message : String(err),
      }, "whatsapp.webhook.intake_failed");
    }
  }

  for (const [tenantId, casos] of paraElAgente) scheduleAgent([...casos], tenantId, true, hasta);

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
    return {
      status: 500,
      cuerpo: {
        error: {
          code: "INTAKE_FAILED",
          message: "Some messages could not be stored.",
        },
      },
    };
  }

  // 200 para un evento bien firmado que se guardó entero —incluidos los de
  // estado y lectura, que no traen mensajes— para que Meta lo marque
  // entregado y deje de reintentar.
  return {
    status: 200,
    cuerpo: {
      ok: true,
      received: caseIds.length,
      case_ids: caseIds,
      ...(descartados > 0 ? { ignored_other_number: descartados } : {}),
    },
  };
}
