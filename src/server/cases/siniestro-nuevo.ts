/**
 * Un WhatsApp que cuenta otro siniestro no se suma al caso terminado: abre uno
 * nuevo, que el agente atiende como cualquier denuncia.
 *
 * Lo llama el clasificador de mensajes tardíos cuando el mensaje de un teléfono
 * con un caso terminado es un `siniestro_nuevo`. Pasa al caso nuevo ese mensaje
 * y todo lo que entró después, con sus adjuntos y sus crudos; lo anterior se
 * queda en el caso de antes.
 *
 * El estado del caso de antes no se toca: la IA no saca un caso de un estado
 * terminal (LLM08). Lo único que cambia ahí es que pierde la clase del mensaje
 * que se fue y, si no le queda ningún entrante sin contestar, la marca de
 * «Para responder».
 *
 * El corte arranca en el primer entrante sin contestar del episodio, no en el
 * mensaje clasificado: lo que la persona mandó junto es una sola denuncia.
 *
 * No parte un caso que tomó una persona, un caso ya partido, ni un caso al que
 * una persona contestó por WhatsApp en las últimas 24 h. Todo eso se decide en
 * el INSERT, después del lock. `assigned_to` no pasa al caso nuevo.
 *
 * Todo va en un lote, una transacción. Lo primero es un lock por caso: dos
 * corridas sobre el mismo mensaje (una reentrega de Meta, el barrido) verían las
 * dos «el mensaje sigue acá» y abrirían dos casos. La segunda espera, y su
 * INSERT mira después del lock: el mensaje ya se mudó y no abre nada.
 *
 * Nunca tira: ante cualquier falla devuelve `sigue`, que es el camino de antes.
 */

import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { enTenantVarias } from "@/data/scope";
import { PLANTILLA_RESPUESTA_HUMANA } from "@/core/whatsapp/plantillas";
import { VENTANA_WHATSAPP_MS } from "@/core/whatsapp/puede-responder";
import { cases, claimAttachments, claimMessages, rawMessages } from "@/lib/db/schema";
import { AuditEvent } from "@/lib/audit/log";
import { filasDe } from "@/lib/db/filas";
import { logger } from "@/lib/observability/logger";
import { errorCode } from "@/lib/observability/error-code";
import { auditoriaSiExiste } from "@/server/cases/auditoria-si-quedo";
import { fuePartido } from "@/server/cases/caso-partido";
import { noLoTomoUnaPersona } from "@/server/cases/devolver-al-agente";
import { admiteParaResponder, haySinContestar, ultimaRespuesta } from "@/server/cases/para-responder";

export type CorteDeSiniestro =
  | { tipo: "abierto"; casoNuevo: string; movidos: number }
  | { tipo: "ya_movido" }
  | { tipo: "sigue" };

export async function abrirCasoPorSiniestroNuevo(o: {
  tenantId: string;
  caseId: string;
  messageId: string;
}): Promise<CorteDeSiniestro> {
  const { tenantId, caseId, messageId } = o;
  const ctx = { tenantId };
  try {
    // Lo genera la app para que todo el lote pueda nombrar el caso nuevo.
    const nuevo = randomUUID();
    const hayNuevo = sql`exists (select 1 from cases n where n.id = ${nuevo}::uuid)`;

    const r = await enTenantVarias(ctx, (db) => [
      db.execute(sql`select pg_advisory_xact_lock(hashtext('siniestro_nuevo'), hashtext(${caseId}::text))`),
      // En crudo: `insert().select()` de drizzle pide todas las columnas. Sin alias
      // en el `cases` de afuera, o `admiteParaResponder()` no lo encuentra.
      // `waba_propia` sale del mensaje que se parte y no del caso de antes: el caso viejo pudo
      // abrirse por otro número (el cliente cambió de número) y el nuevo pesa según por dónde entró éste.
      db.execute(sql`
        insert into cases (id, tenant_id, channel, waba_propia, status, email_thread_id, is_claim, claim_type, extraction_pending)
        select ${nuevo}::uuid, cases.tenant_id, cases.channel,
               coalesce((select m.raw_payload->>'waba_propia' = 'true' from claim_messages m where m.id = ${messageId}::uuid), false),
               'recibido', cases.email_thread_id, null, null, true
        from cases
        where cases.id = ${caseId}::uuid
          and cases.channel in ('whatsapp', 'whatsapp_sim')
          and cases.email_thread_id is not null
          and ${admiteParaResponder()}
          and exists (select 1 from claim_messages m
                      where m.id = ${messageId}::uuid and m.case_id = cases.id and m.direction = 'inbound')
          and not ${fuePartido(cases.id)}
          and ${noLoTomoUnaPersona(db)}
          and not exists (select 1 from outbound_messages o
                          where o.case_id = cases.id and o.template = ${PLANTILLA_RESPUESTA_HUMANA}
                            and o.created_at > now() - interval '${sql.raw(String(VENTANA_WHATSAPP_MS))} milliseconds')
        returning id
      `),
      db
        .update(claimMessages)
        .set({ case_id: nuevo })
        .where(
          and(
            eq(claimMessages.case_id, caseId),
            eq(claimMessages.direction, "inbound"),
            sql`${claimMessages.received_at} >= least(
              (select m.received_at from claim_messages m where m.id = ${messageId}::uuid),
              (select min(m.received_at) from claim_messages m
                where m.case_id = ${caseId}::uuid and m.direction = 'inbound'
                  and m.received_at > ${ultimaRespuesta(sql`${caseId}::uuid`)}))`,
            hayNuevo
          )
        )
        .returning({ id: claimMessages.id }),
      db
        .update(claimAttachments)
        .set({ case_id: nuevo })
        .where(
          and(
            eq(claimAttachments.case_id, caseId),
            sql`${claimAttachments.claim_message_id} in (select m.id from claim_messages m where m.case_id = ${nuevo}::uuid)`
          )
        ),
      // El ingreso escribe la misma hora en el mensaje y en su crudo.
      db
        .update(rawMessages)
        .set({ case_id: nuevo })
        .where(
          and(
            eq(rawMessages.case_id, caseId),
            sql`${rawMessages.received_at} in (select m.received_at from claim_messages m where m.case_id = ${nuevo}::uuid)`
          )
        ),
      db
        .update(cases)
        .set({
          mensaje_tardio_de: null,
          mensaje_tardio_tipo: null,
          mensaje_tardio_resumen: null,
          mensaje_tardio_reservado_en: null,
          para_responder_desde: sql`case when ${haySinContestar(db)} then ${cases.para_responder_desde} else null end`,
        })
        .where(and(eq(cases.id, caseId), hayNuevo)),
      auditoriaSiExiste(
        db,
        {
          caseId,
          actorId: null,
          eventType: AuditEvent.LATE_MESSAGE_SPLIT,
          payload: sql<Record<string, unknown>>`jsonb_build_object(
            'message_id', ${messageId}::text, 'caso_nuevo', ${nuevo}::text,
            'movidos', (select count(*) from claim_messages m where m.case_id = ${nuevo}::uuid))`,
        },
        nuevo
      ),
      auditoriaSiExiste(
        db,
        {
          caseId: nuevo,
          actorId: null,
          eventType: AuditEvent.OPENED_FROM_LATE_MESSAGE,
          payload: sql<Record<string, unknown>>`jsonb_build_object(
            'message_id', ${messageId}::text, 'caso_anterior', ${caseId}::text,
            'movidos', (select count(*) from claim_messages m where m.case_id = ${nuevo}::uuid))`,
        },
        nuevo
      ),
      db.select({ case_id: claimMessages.case_id }).from(claimMessages).where(eq(claimMessages.id, messageId)),
    ]);

    if (filasDe(r[1]).length === 1) {
      const movidos = filasDe(r[2]).length;
      logger.info({ case_id: caseId, caso_nuevo: nuevo, movidos }, "siniestro_nuevo.abierto");
      return { tipo: "abierto", casoNuevo: nuevo, movidos };
    }

    // Otra corrida ya lo mudó: el mensaje no está donde lo dejó el ingreso.
    const [donde] = filasDe<{ case_id: string }>(r[8]);
    if (donde && donde.case_id !== caseId) return { tipo: "ya_movido" };
    logger.info({ case_id: caseId }, "siniestro_nuevo.no_corresponde");
    return { tipo: "sigue" };
  } catch (err) {
    logger.warn({ case_id: caseId, error_code: errorCode(err) }, "siniestro_nuevo.no_se_pudo");
    return { tipo: "sigue" };
  }
}
