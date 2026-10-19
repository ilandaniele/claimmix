/**
 * Un `audit_log` guardado sólo si el UPDATE que lo acompaña pegó.
 *
 * La confirmación de «listo para Core» (P6) y la reapertura por abandono (P8)
 * comparten el mismo problema: el batch HTTP de Neon es una sola transacción,
 * pero un UPDATE con guarda que no matchea ninguna fila no es un error — es un
 * SELECT con cero filas. Sin esto, esa auditoría se escribía igual, y quedaba
 * un `case.ready_confirmed` sobre un estado que en realidad no cambió.
 *
 * El INSERT ... SELECT mira si la fila quedó en `estado` y la tocó esta misma
 * transacción: si el SELECT no devuelve fila, el INSERT no inserta nada, y no
 * hace falta ningún chequeo aparte.
 *
 * «La tocó esta transacción» es `updated_at = now()`, no la hora que puso el
 * código: `trg_cases_updated_at` la pisa con `now()`, que es el comienzo de la
 * transacción. Comparar contra la hora del código no matcheaba nunca, y ni la
 * confirmación de listo ni la reapertura ni la devolución quedaban auditadas.
 *
 * Drizzle exige que el SELECT traiga cada columna de la tabla, en su orden,
 * `id` y `created_at` incluidos; si falta una, tira antes de mandar nada.
 */

import "server-only";
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { auditLog, cases } from "@/lib/db/schema";
import type { ClienteDatos } from "@/data/scope";
import { ESTADOS_ESCALADO } from "@/core/case/fsm";
import { EVENTOS_DE_INTERVENCION } from "@/core/metricas/intervencion";
import { EVENTOS_CON_ESTADO } from "@/core/metricas/transiciones";
import { AuditEvent, ipValida, type AuditEventType } from "@/lib/audit/log";
import type { CaseStatus } from "@/lib/schemas/cases";
import { DEL_CASO, HACIA, SE_APLICO, literales } from "@/server/metrics/trayecto";

type FilaDeAuditoria = {
  caseId: string;
  actorId: string | null;
  eventType: AuditEventType;
  ip?: string | null;
  ua?: string | null;
};

/** El INSERT ... SELECT desde la fila del caso, con el `where` y el payload que decide cada guarda. */
function auditoriaDesdeElCaso(
  db: ClienteDatos,
  a: FilaDeAuditoria,
  payload: SQL<Record<string, unknown>>,
  donde: SQL | undefined
) {
  // `getClientIp` puede devolver "anonymous", que no es un `inet` válido y
  // tiraría abajo todo el batch.
  const ip = ipValida(a.ip);

  return db.insert(auditLog).select(
    db
      .select({
        id: sql<number>`nextval(pg_get_serial_sequence('public.audit_log', 'id'))`.as("id"),
        tenant_id: cases.tenant_id,
        actor_id: sql<string | null>`${a.actorId}::uuid`.as("actor_id"),
        event_type: sql<string>`${a.eventType}::text`.as("event_type"),
        target_type: sql<string>`'case'::text`.as("target_type"),
        target_id: sql<string>`${a.caseId}::text`.as("target_id"),
        payload: payload.as("payload"),
        ip: sql<string | null>`${ip}::inet`.as("ip"),
        ua: sql<string | null>`${a.ua ?? null}::text`.as("ua"),
        created_at: sql<string>`now()`.as("created_at"),
      })
      .from(cases)
      .where(donde)
  );
}

export function auditoriaSiQuedo(
  db: ClienteDatos,
  a: FilaDeAuditoria & { payload: Record<string, unknown> },
  estado: CaseStatus
) {
  return auditoriaDesdeElCaso(
    db,
    a,
    sql`${JSON.stringify(a.payload)}::jsonb`,
    and(eq(cases.id, a.caseId), eq(cases.status, estado), sql`${cases.updated_at} = now()`)
  );
}

/**
 * Un `audit_log` de cambio de estado guardado sólo si el estado de verdad va
 * a cambiar. Va ANTES del UPDATE en el lote: lee el estado de antes, que es
 * el `from` que anota, y el UPDATE de después lo pisa.
 *
 * El agente vuelve a escribir el estado que el caso ya tiene cada vez que le
 * llega un mensaje (`info_faltante` sobre `info_faltante`): eso no es un
 * cambio y no deja fila, o el trayecto del caso se llenaría de tramos vacíos
 * que le rompen la cuenta de cuánto estuvo en cada estado.
 *
 * `desde` son los estados que el UPDATE deja pisar: la misma guarda, para no
 * anotar un cambio que el UPDATE va a rechazar. Las dos sentencias van en el
 * mismo lote —una transacción—, así que sólo otra escritura simultánea, en los
 * milisegundos entre una y otra, las desacoplaría.
 */
export function auditoriaSiCambia(
  db: ClienteDatos,
  a: FilaDeAuditoria & { payload: Record<string, unknown>; desde: readonly CaseStatus[] },
  hacia: CaseStatus
) {
  return auditoriaDesdeElCaso(
    db,
    a,
    sql`${JSON.stringify(a.payload)}::jsonb || jsonb_build_object('from', ${cases.status}::text, 'old_status', ${cases.status}::text, 'to', ${hacia}::text, 'new_status', ${hacia}::text)`,
    and(eq(cases.id, a.caseId), inArray(cases.status, a.desde), ne(cases.status, hacia))
  );
}

/** Un `audit_log` guardado sólo si el caso `caso`, creado antes en el mismo lote, existe. */
export function auditoriaSiExiste(
  db: ClienteDatos,
  a: FilaDeAuditoria & { payload: SQL<Record<string, unknown>> },
  caso: string
) {
  return auditoriaDesdeElCaso(
    db,
    a,
    a.payload,
    and(eq(cases.id, a.caseId), sql`exists (select 1 from cases n where n.id = ${caso}::uuid)`)
  );
}

/**
 * El momento desde el que una derivación vuelve a ser nueva: el último de los
 * dos, o `-infinity` si el caso nunca salió del agente.
 *
 * - Una persona tocó el caso (cualquier intervención con actor, menos Re-analizar:
 *   lo pide una persona pero el caso sigue siendo del agente) o
 * - el caso salió de los escalados y volvió: un paso a un estado que no es de
 *   derivación, o una reapertura. La extracción no cuenta: es la corrida del
 *   agente, y el worker la anota DESPUÉS de derivar, con el estado que calculó antes.
 *
 * Los eventos van como literales, por lo mismo que en `trayecto`: sólo así
 * Postgres usa `idx_audit_log_trayecto`.
 */
const INTERVENCIONES_DE_PERSONA = literales(
  EVENTOS_DE_INTERVENCION.filter((e) => e !== "case.re_analyze_triggered")
);
const CAMBIOS_DE_ESTADO = literales(
  EVENTOS_CON_ESTADO.filter((e) => e !== AuditEvent.EXTRACTION_COMPLETE && e !== AuditEvent.AI_EXTRACTED)
);
const ESCALADOS = literales([...ESTADOS_ESCALADO]);

const ANCLA = sql`coalesce(greatest(
  (select max(a.created_at) from audit_log a
    where ${DEL_CASO} and a.event_type in (${INTERVENCIONES_DE_PERSONA}) and a.actor_id is not null),
  (select max(a.created_at) from audit_log a
    where ${DEL_CASO} and a.event_type in (${CAMBIOS_DE_ESTADO}) and ${HACIA} not in (${ESCALADOS})
      and ${SE_APLICO})
), '-infinity'::timestamptz)`;

/**
 * Un `claim.specialist_required` guardado sólo si el caso no tiene ya uno de
 * este episodio de derivación.
 *
 * `escalate()` puede correr más de una vez sobre el mismo caso —dos ramas de
 * la misma vuelta, una vuelta que repite—, y `setStatus` acepta que el estado
 * sea el mismo. Sin esto cada pasada dejaba su fila, y su mensaje al
 * asegurado. Un episodio es lo que hay desde que el caso volvió al agente
 * (ver `ANCLA`): ahí empieza uno nuevo.
 *
 * No alcanza con el NOT EXISTS: en READ COMMITTED dos transacciones que corren
 * a la vez ven las dos «no existe». Quien llama toma antes el lock del caso en
 * el mismo lote (ver `anotarDerivacionSiEsNueva`).
 *
 * Devuelve la fila que insertó; sin fila, la derivación no era nueva.
 */
export function auditoriaSiEsDerivacionNueva(
  db: ClienteDatos,
  a: FilaDeAuditoria & { payload: SQL<Record<string, unknown>> }
) {
  return auditoriaDesdeElCaso(
    db,
    a,
    a.payload,
    and(
      eq(cases.id, a.caseId),
      sql`not exists (
        select 1 from audit_log x
         where x.target_type = 'case' and x.target_id = ${cases.id}::text and x.tenant_id = ${cases.tenant_id}
           and x.event_type = ${literales([AuditEvent.SPECIALIST_REQUIRED])}
           and x.created_at > ${ANCLA}
      )`
    )
  ).returning({ id: auditLog.id });
}
