import "server-only";

import { and, eq, exists, gt, inArray, isNotNull, notExists, notInArray, or, sql } from "drizzle-orm";
import { enTenant, type TenantContext } from "@/data/scope";
import { cases, claimMessages, outboundMessages } from "@/lib/db/schema";
import { ESTADOS_DEL_AGENTE_TERMINADO } from "@/core/case/para-responder";
import { ETAPA_AVISO_DE_CIERRE } from "@/core/case/recordatorios";
import { AuditEvent } from "@/lib/audit/log";
import { logger } from "@/lib/observability/logger";

/**
 * Lo cerró el barrido por silencio y nadie lo cerró a mano después: el último
 * cierre auditado es el del barrido.
 */
export function cerradoPorSilencio() {
  return and(
    eq(cases.status, "cerrado"),
    sql`exists (select 1 from audit_log a
          where a.target_type = 'case' and a.target_id = ${cases.id}::text
            and a.event_type = ${AuditEvent.CASE_CLOSED_ABANDONED}
            and a.created_at >= ${cases.closed_at})`
  )!;
}

/**
 * El caso puede quedar en «Para responder»: el agente terminó con él, o lo
 * cerró el silencio, le salió el aviso de cierre (B4) y la persona volvió. Sin
 * aviso (recordatorios apagados, o un cierre de antes de B4) la respuesta queda
 * en la auditoría, como antes. Un cierre a mano sigue siendo la última palabra.
 */
export function admiteParaResponder() {
  return or(
    inArray(cases.status, [...ESTADOS_DEL_AGENTE_TERMINADO]),
    and(
      cerradoPorSilencio(),
      sql`exists (select 1 from case_recordatorios r
            where r.case_id = ${cases.id} and r.etapa = ${ETAPA_AVISO_DE_CIERRE} and r.resultado = 'enviar')`
    )
  )!;
}

/**
 * Con qué entrante de la persona se marca. Sin esto, con cualquiera.
 *
 * - `sinLeer`: el worker, con los que leyó. Uno que entró mientras corría no lo
 *   contestó nadie, aunque la última respuesta del agente sea posterior.
 * - `sinContestar`: la reentrega de Meta. Si el mensaje ya lo leyó el agente, su
 *   respuesta es posterior y no hay nada que marcar.
 */
export type SoloSiHay = { sinLeer: string[] } | "sinContestar";

/** Lo que pone un caso en «Para responder». */
function marca() {
  return {
    // Guarda cuándo llegó el primero que nadie contestó.
    para_responder_desde: sql`coalesce(${cases.para_responder_desde}, now())`,
    // Un episodio nuevo no hereda la clase del anterior; el mismo, la conserva.
    mensaje_tardio_de: sql`case when ${cases.para_responder_desde} is null then null else ${cases.mensaje_tardio_de} end`,
    mensaje_tardio_tipo: sql`case when ${cases.para_responder_desde} is null then null else ${cases.mensaje_tardio_tipo} end`,
    mensaje_tardio_resumen: sql`case when ${cases.para_responder_desde} is null then null else ${cases.mensaje_tardio_resumen} end`,
    // La ventana de siete días de WhatsApp cuenta desde acá.
    updated_at: new Date().toISOString(),
  };
}

/**
 * Pone el caso en «Para responder» si el agente ya terminó con él.
 *
 * La llama el ingreso con el mensaje de la persona recién guardado: el worker
 * también despierta por un re-despacho o un reproceso sin nada nuevo que leer.
 * La llama además el worker al terminar, para lo que entró mientras corría.
 *
 * Tira si la base falla: WhatsApp devuelve 500 y Meta reintenta. Quien no puede
 * reintentar lo atrapa.
 */
export async function marcarParaResponder(
  caseId: string,
  tenantId: string,
  soloSiHay?: SoloSiHay
): Promise<void> {
  try {
    await enTenant({ tenantId }, (db) => {
      const entrante = soloSiHay
        ? exists(
            db
              .select({ id: claimMessages.id })
              .from(claimMessages)
              .where(
                and(
                  eq(claimMessages.case_id, cases.id),
                  eq(claimMessages.direction, "inbound"),
                  soloSiHay === "sinContestar"
                    ? gt(
                        claimMessages.received_at,
                        sql`coalesce((select max(${outboundMessages.created_at}) from ${outboundMessages} where ${outboundMessages.case_id} = ${cases.id}), '-infinity'::timestamptz)`
                      )
                    : notInArray(claimMessages.id, soloSiHay.sinLeer)
                )
              )
          )
        : undefined;
      return db
        .update(cases)
        .set(marca())
        .where(
          and(eq(cases.id, caseId), admiteParaResponder(), entrante)
        );
    });
  } catch (err) {
    logger.error(
      { detalle: err instanceof Error ? err.name : "UnknownError", case_id: caseId },
      "para_responder.no_se_pudo_marcar"
    );
    throw err;
  }
}

/**
 * Pone el caso en «Para responder» sin mirar el estado: el tope por remitente
 * (E12) llega en mitad de la conversación, cuando el agente no terminó, y el
 * mensaje excedente lo contesta una persona. Tira si la base falla.
 */
export async function marcarParaResponderAunqueSigaElAgente(
  caseId: string,
  tenantId: string
): Promise<void> {
  await enTenant({ tenantId }, (db) =>
    db.update(cases).set(marca()).where(eq(cases.id, caseId))
  );
}

// `received_at` se toma antes del INSERT: un mensaje con hora anterior a `visto`
// puede no haber estado guardado cuando se cargó el caso.
const MARGEN_DEL_INSERT = "10 seconds";

/**
 * Saca el caso de «Para responder». Devuelve si había algo que sacar.
 *
 * `visto` es cuándo la persona cargó el caso: si entró un mensaje después, no lo
 * vio, y el caso sigue marcado.
 *
 * Sin filtro por inquilino a mano: un caso de otro lo esconde la base y vuelve
 * `false`, igual que uno que no estaba marcado.
 */
export async function marcarRespondido(
  ctx: TenantContext,
  caseId: string,
  visto: string
): Promise<boolean> {
  const filas = await enTenant(ctx, (db) =>
    db
      .update(cases)
      .set({ para_responder_desde: null })
      .where(
        and(
          eq(cases.id, caseId),
          isNotNull(cases.para_responder_desde),
          notExists(
            db
              .select({ id: claimMessages.id })
              .from(claimMessages)
              .where(
                and(
                  eq(claimMessages.case_id, cases.id),
                  eq(claimMessages.direction, "inbound"),
                  gt(
                    claimMessages.received_at,
                    sql`${visto}::timestamptz - ${MARGEN_DEL_INSERT}::interval`
                  )
                )
              )
          )
        )
      )
      .returning({ id: cases.id })
  );
  return filas.length > 0;
}
