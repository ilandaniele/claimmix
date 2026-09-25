import "server-only";

import { and, eq, exists, gt, inArray, isNotNull, notExists, notInArray, sql } from "drizzle-orm";
import { enTenant, type TenantContext } from "@/data/scope";
import { cases, claimMessages, outboundMessages } from "@/lib/db/schema";
import { ESTADOS_DEL_AGENTE_TERMINADO } from "@/core/case/para-responder";
import { logger } from "@/lib/observability/logger";

/**
 * Con qué entrante de la persona se marca. Sin esto, con cualquiera.
 *
 * - `sinLeer`: el worker, con los que leyó. Uno que entró mientras corría no lo
 *   contestó nadie, aunque la última respuesta del agente sea posterior.
 * - `sinContestar`: la reentrega de Meta. Si el mensaje ya lo leyó el agente, su
 *   respuesta es posterior y no hay nada que marcar.
 */
export type SoloSiHay = { sinLeer: string[] } | "sinContestar";

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
        .set({
          // Guarda cuándo llegó el primero que nadie contestó.
          para_responder_desde: sql`coalesce(${cases.para_responder_desde}, now())`,
          // La ventana de siete días de WhatsApp cuenta desde el último mensaje.
          updated_at: new Date().toISOString(),
        })
        .where(
          and(eq(cases.id, caseId), inArray(cases.status, [...ESTADOS_DEL_AGENTE_TERMINADO]), entrante)
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
