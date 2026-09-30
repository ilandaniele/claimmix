/**
 * El trayecto de cada caso, leído de la auditoría: cuánto tarda en llegar a
 * «listo», en cerrarse, dónde se queda y si llegó solo (B14 y B15).
 *
 * Tres consultas, todas builders para que entren en el mismo lote de
 * `getTenantKpis`. El aislamiento por inquilino lo pone RLS, como en el resto
 * de las métricas; los `tenant_id` que se ven acá sólo le dicen a Postgres que
 * cruce la fila de auditoría con el caso y no con el de otro inquilino.
 *
 * Los eventos van escritos como literales y no como parámetros: para usar el
 * índice parcial `idx_audit_log_trayecto` Postgres tiene que PROBAR que el
 * `event_type in (...)` de la consulta cae adentro del predicado del índice, y
 * con `$1, $2, …` no puede. Los nombres salen de las listas de `core/metricas`
 * y se validan antes de escribirse en el SQL.
 */

import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { ESTADOS_CERRADOS, ESTADOS_ESCALADO } from "@/core/case/fsm";
import { ZONA_ARGENTINA } from "@/core/fecha/dia-argentino";
import { EVENTOS_DE_INTERVENCION } from "@/core/metricas/intervencion";
import { EVENTOS_CON_ESTADO, EXTRACCION_INTERMEDIA } from "@/core/metricas/transiciones";
import type { ClienteDatos } from "@/data/scope";
import { auditLog, cases, claimMessages, outboundMessages } from "@/lib/db/schema";
import { completadoConfirmado } from "@/server/cases/listo-confirmado";

const NOMBRE_LITERAL = /^[a-z_.]+$/;

/** `'a', 'b'` para un `in (...)`: sólo nombres de evento o de estado, nunca texto de afuera. */
export function literales(nombres: readonly string[]): SQL {
  for (const n of nombres) {
    if (!NOMBRE_LITERAL.test(n)) throw new Error(`Nombre inválido para el SQL: ${n}`);
  }
  return sql.raw(nombres.map((n) => `'${n}'`).join(", "));
}

export const CON_ESTADO = literales(EVENTOS_CON_ESTADO);
export const INTERVENCION = literales(EVENTOS_DE_INTERVENCION);
const ESCALADOS = literales([...ESTADOS_ESCALADO]);
const CERRADOS = literales([...ESTADOS_CERRADOS]);

/** El estado al que pasó el caso, con el nombre de clave que haya usado cada escritor. */
export const HACIA = sql.raw("coalesce(a.payload->>'new_status', a.payload->>'to')");
/** Los eventos de Core con `status_not_applied` avisan que el estado NO se movió. */
export const SE_APLICO = sql.raw("(a.payload->>'status_not_applied') is distinct from 'true'");
/** El `listo` que deja la extracción no es el de `listo_para_core`: lo pisa a los milisegundos. */
export const NO_ES_INTERMEDIO = sql.raw(
  `not (a.event_type = '${EXTRACCION_INTERMEDIA.evento}' and a.payload->>'new_status' = '${EXTRACCION_INTERMEDIA.estado}')`
);
export const DEL_CASO = sql`a.target_type = 'case' and a.target_id = ${cases.id}::text and a.tenant_id = ${cases.tenant_id}`;

/** Los reclamos que entraron por un canal real en el rango: los simulados no miden nada. */
const cohorte = (desde: string, hasta: string): SQL =>
  sql`${cases.created_at} >= ${desde} and ${cases.created_at} < ${hasta} and ${cases.channel} in ('whatsapp', 'email') and ${cases.is_claim} is true`;

/**
 * Una fila por caso de la cohorte, con lo que hace falta para medirlo.
 *
 * - `t_listo`: la primera vez que pasó a `listo_para_core`.
 * - `solo`: llegó a ese estado sin que una persona hubiera tocado el caso antes
 *   —ni en el mismo instante—. Es un piso: un caso viejo, de antes de que el
 *   cambio de estado del agente se auditara, no tiene `t_listo` y no cuenta.
 * - `mensajes`: lo que dijeron las dos partes, y sólo lo que llegó o salió de
 *   verdad. `claim_messages` ya trae los mails, pero también los `queued` y
 *   `failed` que nunca salieron: se cuentan los `received` y los `sent`. A
 *   `outbound_messages` sólo se le suma WhatsApp `sent`, o cada mail se
 *   contaría dos veces.
 */
function hechosPorCaso(desde: string, hasta: string): SQL {
  return sql`(
    select ${cases.id} as id,
           ${cases.created_at} as created_at,
           ${cases.closed_at} as closed_at,
           ${cases.status} as status,
           ${completadoConfirmado} as completado,
           l.t_listo as t_listo,
           (l.t_listo is not null and not exists (
             select 1 from ${auditLog} a
              where ${DEL_CASO} and a.event_type in (${INTERVENCION})
                and a.actor_id is not null and a.created_at <= l.t_listo
           )) as solo,
           (select count(*) from ${claimMessages} m where m.case_id = ${cases.id} and m.status in ('received', 'sent'))::int
             + (select count(*) from ${outboundMessages} o
                 where o.case_id = ${cases.id} and o.channel = 'whatsapp' and o.status = 'sent')::int as mensajes
      from ${cases}
     cross join lateral (
       select min(a.created_at) as t_listo from ${auditLog} a
        where ${DEL_CASO} and a.event_type in (${CON_ESTADO}) and ${SE_APLICO} and ${HACIA} = 'listo_para_core'
     ) l
     where ${cohorte(desde, hasta)}
  ) x`;
}

const horas = (desde: string, hasta: string) => `extract(epoch from (${hasta} - ${desde})) / 3600`;

const CERRO_DE_VERDAD = "x.status in ('pagado', 'rechazado') and x.closed_at is not null";

/** Lo que se calcula sobre un grupo de casos: el rango entero para el tablero, un mes para el historial. */
function agregados() {
  return {
    reclamos: sql<number>`count(*)::int`,
    con_listo: sql<number>`count(x.t_listo)::int`,
    mediana_horas_listo: sql<number | null>`(percentile_cont(0.5) within group (order by ${sql.raw(horas("x.created_at", "x.t_listo"))}) filter (where x.t_listo is not null))::float8`,
    con_cierre: sql<number>`(count(*) filter (where ${sql.raw(CERRO_DE_VERDAD)}))::int`,
    mediana_horas_cierre: sql<number | null>`(percentile_cont(0.5) within group (order by ${sql.raw(horas("x.created_at", "x.closed_at"))}) filter (where ${sql.raw(CERRO_DE_VERDAD)}))::float8`,
    sin_intervencion: sql<number>`(count(*) filter (where x.solo))::int`,
    mensajes_por_caso: sql<number | null>`avg(x.mensajes)::float8`,
  };
}

/** Una fila: el ciclo, la intervención y los mensajes de los reclamos del rango. */
export function consultaDeCiclo(db: ClienteDatos, desde: string, hasta: string) {
  return db.select(agregados()).from(hechosPorCaso(desde, hasta));
}

/**
 * El mes a mes: lo mismo que el ciclo, agrupado por mes de apertura en hora
 * argentina, más cuántos quedaron completados, escalados y cerrados AHORA.
 * Sin datos de personas ni de casos: sale directo al CSV.
 */
export function consultaDeHistorial(db: ClienteDatos, desde: string, hasta: string) {
  return db
    .select({
      mes: sql<string>`to_char(date_trunc('month', x.created_at at time zone ${ZONA_ARGENTINA}), 'YYYY-MM')`,
      ...agregados(),
      completados: sql<number>`(count(*) filter (where x.completado))::int`,
      escalados: sql<number>`(count(*) filter (where x.status in (${ESCALADOS})))::int`,
      cerrados: sql<number>`(count(*) filter (where x.status in (${CERRADOS})))::int`,
    })
    .from(hechosPorCaso(desde, hasta))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
}

/**
 * Cuánto se queda un caso en cada estado, de mayor a menor: el cuello de botella.
 *
 * Cuatro capas, cada una necesita la anterior ya resuelta porque una ventana
 * se calcula antes del WHERE de su propio nivel:
 *   1. los cambios de estado de cada caso, ya normalizados (`estado`, `t`);
 *   2. `lag`, para ver cuáles repiten el estado anterior;
 *   3. sin los repetidos —un cambio de estado con reasignación se guarda dos
 *      veces— y `lead`, que da cuándo terminó cada estadía;
 *   4. el promedio por estado.
 *
 * Quedan afuera la primera estadía del caso (no hay evento que diga cuándo
 * empezó) y la que sigue abierta (todavía no terminó).
 */
export function consultaDeCuellos(db: ClienteDatos, desde: string, hasta: string) {
  const cambios = sql`(
    select c.id as caso, e.id as evento, e.t as t, e.estado as estado
      from (select ${cases.id} as id, ${cases.tenant_id} as tenant_id from ${cases} where ${cohorte(desde, hasta)}) c
     cross join lateral (
       select a.id as id, a.created_at as t, ${HACIA} as estado from ${auditLog} a
        where a.target_type = 'case' and a.target_id = c.id::text and a.tenant_id = c.tenant_id
          and a.event_type in (${CON_ESTADO}) and ${SE_APLICO} and ${NO_ES_INTERMEDIO}
          and ${HACIA} is not null
     ) e
  ) cambios`;
  const conPrevio = sql`(
    select caso, evento, t, estado, lag(estado) over (partition by caso order by t, evento) as previo
      from ${cambios}
  ) con_previo`;
  const estadias = sql`(
    select estado, t, lead(t) over (partition by caso order by t, evento) as hasta
      from ${conPrevio}
     where previo is distinct from estado
  ) estadias`;
  return db
    .select({
      estado: sql<string>`estadias.estado`,
      horas_promedio: sql<number>`avg(${sql.raw(horas("estadias.t", "estadias.hasta"))})::float8`,
      estancias: sql<number>`count(*)::int`,
    })
    .from(estadias)
    .where(sql`estadias.hasta is not null`)
    .groupBy(sql`1`)
    .orderBy(sql`2 desc`);
}
