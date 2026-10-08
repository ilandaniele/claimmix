/**
 * La revisión nocturna de calidad (B22): busca los casos que se salieron de lo
 * esperado y guarda un desvío por cada uno en `case_desvios`.
 *
 * Cuelga del barrido de `reap-stuck` (Hobby da dos crons por día y los dos
 * están usados), que sólo la dispara una vez por día aunque lo llamen cada
 * quince minutos. Una regla, una sentencia `INSERT … SELECT … ON CONFLICT DO
 * NOTHING`: la clave primaria (caso, regla, ancla) es la idempotencia, así que
 * correrla dos veces —o dos corridas a la par— no duplica nada, y no hay que
 * traer los casos a memoria para compararlos con su historial.
 *
 * Cada regla corre sola: si una falla se registra, vuelve en `fallidas` y las
 * demás siguen. Un desvío que no se encontró esta noche se encuentra la siguiente.
 *
 * Es un barrido de sistema sobre los casos de todos los inquilinos, con el rol
 * dueño (la tabla sólo se lee con `claimmix_app`). Cada fila lleva el
 * `tenant_id` de su caso, que es lo que después filtra la política de lectura.
 *
 * Los eventos van escritos como literales y no como parámetros, por lo mismo
 * que en `metrics/trayecto.ts`: Postgres tiene que poder PROBAR que el
 * `event_type in (...)` cae adentro del índice parcial `idx_audit_log_trayecto`.
 */

import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { ESTADOS_CERRADOS, ESTADOS_COMPLETADO_SIN_PERSONA, ESTADOS_ESCALADO, ESTADOS_ESPERANDO_AL_DENUNCIANTE } from "@/core/case/fsm";
import {
  CANALES_SIMULADOS,
  DIAS_DE_VENTANA_DEL_CIERRE,
  HORAS_DERIVACION_SIN_RESPUESTA,
  HORAS_DOC_SIN_RECIBIR,
  REGLAS,
  type Regla,
} from "@/core/desvios/reglas";
import { db } from "@/lib/db";
import { auditLog, caseDesvios, casePlanPasos, cases, missingDocs, outboundMessages } from "@/lib/db/schema";
import { AuditEvent } from "@/lib/audit/log";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { CON_ESTADO, DEL_CASO, HACIA, INTERVENCION, literales, NO_ES_INTERMEDIO, SE_APLICO } from "@/server/metrics/trayecto";

const ESPERANDO = literales([...ESTADOS_ESPERANDO_AL_DENUNCIANTE]);
const CERRADOS = literales([...ESTADOS_CERRADOS]);
const ESCALADOS = literales([...ESTADOS_ESCALADO]);
const CON_LISTO = literales([...ESTADOS_COMPLETADO_SIN_PERSONA]);
const SIMULADOS = literales([...CANALES_SIMULADOS]);
const DERIVACION = literales([AuditEvent.SPECIALIST_REQUIRED, AuditEvent.SPECIALIST_ALERTED]);
const ABANDONO = literales([AuditEvent.CASE_CLOSED_ABANDONED]);
const CAMBIO_DE_ESTADO = literales([AuditEvent.CASE_STATUS_CHANGED]);

/**
 * El primer cambio de estado del agente que quedó auditado (`trigger = 'agent'`).
 * Antes de ese instante un caso pudo haber pasado por `listo_para_core` sin dejar
 * rastro, y como `case_desvios` sólo se inserta, un falso positivo no se corrige
 * nunca. Sin ningún evento así el `>=` da nulo y la regla no marca nada.
 */
const AUDITORIA_DEL_AGENTE_DESDE = sql`(
  select min(g.created_at) from ${auditLog} g
   where g.target_type = 'case' and g.event_type in (${CAMBIO_DE_ESTADO}) and g.payload->>'trigger' = 'agent')`;

/** Las columnas de todo desvío, en el orden en que las llena cada regla. */
const INSERTAR = sql`insert into ${caseDesvios} (case_id, tenant_id, regla, ancla, dato)`;
const SIN_REPETIR = sql`on conflict (case_id, regla, ancla) do nothing`;

/** El nombre de la regla como literal: sale de una lista cerrada, nunca de afuera. */
const nombre = (regla: Regla): SQL => literales([regla]);

/** Cuántas horas o días, como entero explícito para que la resta de intervalos no dependa de cómo infiera el tipo el driver. */
const horas = (n: number): SQL => sql`${n}::int * interval '1 hour'`;
const dias = (n: number): SQL => sql`${n}::int * interval '1 day'`;

const CONSULTAS: Readonly<Record<Regla, () => SQL>> = {
  /**
   * Un documento que se pidió y no llegó. El pedido sale de `outbound_messages`
   * (`asked_keys` es lo que ese mensaje pidió) y no de `missing_docs.requested_at`,
   * que nadie escribe. Un documento que la persona dijo que no existe
   * (`declined_at`) no cuenta: nada va a llegar. Sólo casos que esperan al
   * denunciante: en otro estado, el documento ya no es lo que frena al caso.
   * El ancla es el primer pedido, así que los reenvíos no abren otro desvío.
   */
  doc_sin_recibir: () => sql`${INSERTAR}
    select d.case_id, d.tenant_id, ${nombre("doc_sin_recibir")}, d.pedido, left(string_agg(distinct d.doc_key, ','), 200)
      from (
        select m.case_id, m.tenant_id, m.doc_key,
               (select min(o.created_at) from ${outboundMessages} o
                 where o.case_id = m.case_id and o.status in ('sent', 'skipped_simulated')
                   and m.doc_key = any(o.asked_keys)) as pedido
          from ${missingDocs} m
          join ${cases} on ${cases.id} = m.case_id
         where m.satisfied_at is null and m.declined_at is null
           and ${cases.status} in (${ESPERANDO}) and ${cases.channel} not in (${SIMULADOS})
      ) d
     where d.pedido <= now() - ${horas(HORAS_DOC_SIN_RECIBIR)}
     group by d.case_id, d.tenant_id, d.pedido
    ${SIN_REPETIR}`,

  /**
   * Un caso que cerró sin haber pasado nunca por «listo». El cierre por
   * abandono es un camino previsto, no un desvío. El `listo` de la extracción
   * es intermedio y no cuenta (`NO_ES_INTERMEDIO`), como en los cuellos de
   * botella. Sólo casos abiertos después de que el agente empezó a auditar su
   * cambio de estado (`AUDITORIA_DEL_AGENTE_DESDE`) y que cerraron en la
   * ventana: ver `DIAS_DE_VENTANA_DEL_CIERRE`.
   */
  cierre_sin_listo: () => sql`${INSERTAR}
    select ${cases.id}, ${cases.tenant_id}, ${nombre("cierre_sin_listo")}, ${cases.closed_at}, ${cases.status}
      from ${cases}
     where ${cases.status} in (${CERRADOS}) and ${cases.closed_at} is not null
       and ${cases.closed_at} >= now() - ${dias(DIAS_DE_VENTANA_DEL_CIERRE)}
       and ${cases.created_at} >= ${AUDITORIA_DEL_AGENTE_DESDE}
       and ${cases.channel} not in (${SIMULADOS})
       and not exists (
         select 1 from ${auditLog} a
          where ${DEL_CASO} and a.event_type in (${CON_ESTADO}) and ${SE_APLICO} and ${NO_ES_INTERMEDIO}
            and ${HACIA} in (${CON_LISTO}))
       and not exists (
         select 1 from ${auditLog} a where ${DEL_CASO} and a.event_type in (${ABANDONO}))
    ${SIN_REPETIR}`,

  /**
   * Un caso derivado al equipo al que nadie tocó. El ancla es la primera marca
   * de derivación posterior a la última vez que una persona intervino (con
   * `actor_id`: el mismo evento sin actor lo escribió el agente): una
   * derivación nueva, después de que alguien atendió el caso, es otro desvío.
   */
  derivacion_sin_respuesta: () => sql`${INSERTAR}
    select ${cases.id}, ${cases.tenant_id}, ${nombre("derivacion_sin_respuesta")}, r.t, null::text
      from ${cases}
     cross join lateral (
       select min(a.created_at) as t from ${auditLog} a
        where ${DEL_CASO} and a.event_type in (${DERIVACION})
          and a.created_at > coalesce((
            select max(i.created_at) from ${auditLog} i
             where i.target_type = 'case' and i.target_id = ${cases.id}::text and i.tenant_id = ${cases.tenant_id}
               and i.event_type in (${INTERVENCION}) and i.actor_id is not null
          ), '-infinity'::timestamptz)
     ) r
     where ${cases.status} in (${ESCALADOS}) and ${cases.channel} not in (${SIMULADOS})
       and r.t is not null and r.t <= now() - ${horas(HORAS_DERIVACION_SIN_RESPUESTA)}
    ${SIN_REPETIR}`,

  /**
   * El plazo del caso (B10) ya pasó y el caso sigue abierto. La agenda no
   * lista los cerrados por lo mismo. El ancla es el vencimiento: si se recalcula
   * (otro plazo, otra ancla), es otro desvío.
   */
  plazo_vencido: () => sql`${INSERTAR}
    select ${cases.id}, ${cases.tenant_id}, ${nombre("plazo_vencido")}, ${cases.vence_en}, left(${cases.vence_plazo}, 40)
      from ${cases}
     where ${cases.vence_en} is not null and ${cases.vence_en} < now()
       and ${cases.status} not in (${CERRADOS}) and ${cases.channel} not in (${SIMULADOS})
    ${SIN_REPETIR}`,

  /**
   * Un caso que cerró con pasos del plan (B11) sin hacer. Los pasos que se
   * tildan solos (`auto`) no cuentan: un `rechazado` nunca va a tener pago.
   */
  plan_sin_terminar: () => sql`${INSERTAR}
    select ${cases.id}, ${cases.tenant_id}, ${nombre("plan_sin_terminar")}, ${cases.closed_at},
           left(string_agg(p.clave, ',' order by p.orden), 200)
      from ${cases}
      join ${casePlanPasos} p on p.case_id = ${cases.id}
     where ${cases.status} in (${CERRADOS}) and ${cases.closed_at} is not null
       and ${cases.closed_at} >= now() - ${dias(DIAS_DE_VENTANA_DEL_CIERRE)}
       and ${cases.channel} not in (${SIMULADOS})
       and p.auto is null and p.hecho_en is null
     group by ${cases.id}, ${cases.tenant_id}, ${cases.closed_at}
    ${SIN_REPETIR}`,
};

export interface ResultadoDeLaRevision {
  /** Los desvíos que se guardaron esta noche: los que ya estaban no cuentan. */
  nuevos: number;
  porRegla: Record<Regla, number>;
  /** Las reglas que no corrieron por un error: el barrido las devuelve y barrer-trabados.yml se pone rojo. */
  fallidas: Regla[];
}

export async function revisarDesvios(): Promise<ResultadoDeLaRevision> {
  const porRegla = Object.fromEntries(REGLAS.map((r) => [r, 0])) as Record<Regla, number>;
  const fallidas: Regla[] = [];

  for (const regla of REGLAS) {
    try {
      // sin-inquilino: barrido de sistema sobre los casos de todos los inquilinos; cada desvío
      // se guarda con el `tenant_id` de su caso, y es la política de lectura la que después filtra.
      const r = await db.execute(CONSULTAS[regla]());
      porRegla[regla] = (r as unknown as { rowCount?: number }).rowCount ?? 0;
    } catch (err) {
      logger.error({ regla, code: errorCode(err) }, "desvios.regla_fallo");
      fallidas.push(regla);
    }
  }

  return { nuevos: REGLAS.reduce((suma, r) => suma + porRegla[r], 0), porRegla, fallidas };
}
