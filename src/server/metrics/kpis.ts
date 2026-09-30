/**
 * Los números de la pantalla de métricas, en un solo lugar.
 *
 * Estaban escritos dos veces: 232 líneas en la pantalla y otras tantas en
 * `/api/metricas`, con las mismas nueve consultas y la misma agregación. Y las
 * dos copias ya habían divergido — para un `claim_type` nulo, la ruta lo
 * agrupaba bajo la clave `"null"` y la pantalla lo descartaba, así que la API
 * y la pantalla que dice servir devolvían `by_type` distintos.
 *
 * Recibe el inquilino ya resuelto: quién puede pedir estos números es decisión
 * de cada borde —la pantalla redirige, la ruta responde 401— y no de acá.
 */

import "server-only";

import { and, count, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  ESTADOS_CERRADOS,
  ESTADOS_COMPLETADO_SIN_PERSONA,
  ESTADOS_ESCALADO,
  FSM_TRANSITIONS,
} from "@/core/case/fsm";

import { mesArgentino, medianocheHaceDias, ZONA_ARGENTINA } from "@/core/fecha/dia-argentino";
import { porcentaje, unDecimal, type FilaDeCiclo, type FilaDeCuello } from "@/core/metricas/ciclo";
import { PERIODO_POR_DEFECTO, rangoDelPeriodo, type Periodo } from "@/core/metricas/periodo";
import {
  completarSerie,
  desdeDe,
  FORMATO_DE,
  type PuntoSerie,
  type Unidad,
} from "@/core/metricas/serie";
import {
  enTenantVarias,
  type ClienteDatos,
  type TenantContext,
} from "@/data/scope";
import { aiUsage, authUsers, cases, users } from "@/lib/db/schema";
import { CANALES_REALES, ClaimTypeSchema } from "@/lib/schemas/cases";
import { completadoConfirmado } from "@/server/cases/listo-confirmado";
import { consultaDeCiclo, consultaDeCuellos } from "@/server/metrics/trayecto";

// ── Data fetching ─────────────────────────────────────────────────────────────

/*
 * `total_cases_month` y `escalated_count` quedaron de cuando el tablero sólo
 * mostraba el mes: hoy siguen el período elegido. `/api/metricas` los devuelve
 * con esos nombres y renombrarlos rompería a quien los lea.
 */
export interface MetricasSummary {
  total_cases_month: number;
  avg_first_response_minutes: number | null;
  /** Antes `auto_completion_rate`: no mide qué hizo el agente solo, mide qué quedó completado y confirmado. */
  completado_confirmado_rate: number;
  escalated_count: number;
  /** De los reclamos del período, el % que llegó a `listo_para_core` sin que una persona tocara el caso. Es un piso. */
  sin_intervencion_rate: number | null;
  /** Mensajes de las dos partes por reclamo del período. */
  mensajes_por_caso: number | null;
  /** Mediana en horas de recibido a listo_para_core (el «tiempo para completar» de B15) y a pagado o rechazado. */
  ciclo: {
    mediana_horas_listo: number | null;
    casos_listo: number;
    mediana_horas_cierre: number | null;
    casos_cierre: number;
  };
  /** Los estados donde los casos se quedan más tiempo, de mayor a menor. */
  cuellos: FilaDeCuello[];
}

export interface ResumenDeAyer {
  reclamos: number;
  whatsapps: number;
  mails: number;
  escalados: number;
  cerrados: number;
  para_responder: number;
  confirmacion_pendiente: number;
}

export interface MetricasData {
  summary: MetricasSummary;
  by_status: Record<string, number>;
  by_type: Record<string, number>;
  top_analysts: Array<{ full_name: string; closed_count: number }>;
  ai_usage: {
    month: AiUsageSummary;
    all_time: AiUsageSummary;
    by_user: AiUsageByUser[];
    by_model: AiUsageByModel[];
  };
  /** El rango del período elegido, `[start, end)`. El uso de IA sigue el mes calendario. */
  period: { start: string; end: string };
  periodo: Periodo;
  /** Sólo si se pidió: /api/metricas no la pide y devuelve null. */
  serie: PuntoSerie[] | null;
  /** Sólo si se pidió: /api/metricas no lo pide y la clave no aparece. */
  ayer?: ResumenDeAyer | null;
}

export interface AiUsageSummary {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface AiUsageByUser extends AiUsageSummary {
  user_id: string | null;
  full_name: string;
  email: string;
}

export interface AiUsageByModel extends AiUsageSummary {
  model: string;
}

function normalizeUsage(row?: {
  calls?: number | string | null;
  prompt_tokens?: number | string | null;
  completion_tokens?: number | string | null;
  cost_usd?: number | string | null;
}): AiUsageSummary {
  const promptTokens = Number(row?.prompt_tokens ?? 0);
  const completionTokens = Number(row?.completion_tokens ?? 0);
  return {
    calls: Number(row?.calls ?? 0),
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    cost_usd: Number(row?.cost_usd ?? 0),
  };
}

/**
 * Reclamos abiertos, WhatsApps y mails atendidos por período, desde `desde`.
 *
 * El período se corta en hora argentina, igual que la ventana del mes: en UTC
 * los casos de las 21 a las 24 caerían en el día siguiente. Las cinco series
 * miran sólo los canales reales (WhatsApp, mail y formulario web): batch-simulate crea cientos de `email_sim`
 * que después quedan como reclamo, y un día de escenarios se leía como un día
 * de 108 reclamos sin ningún mensaje atendido.
 *
 * Agrupa y ordena por ordinal: drizzle manda cada interpolación como un
 * parámetro distinto, así que repetir la expresión en el GROUP BY no sería la
 * misma que la del SELECT para Postgres.
 */
export function consultaDeActividad(db: ClienteDatos, unidad: Unidad, desde: string) {
  const { trunc, fmt } = FORMATO_DE[unidad];
  return db
    .select({
      clave: sql<string>`to_char(date_trunc(${trunc}, ${cases.created_at} at time zone ${ZONA_ARGENTINA}), ${fmt})`,
      reclamos: sql<number>`count(*) filter (where ${cases.is_claim} is true)::int`,
      whatsapps: sql<number>`count(*) filter (where ${cases.channel} = 'whatsapp')::int`,
      mails: sql<number>`count(*) filter (where ${cases.channel} = 'email')::int`,
      reclamos_whatsapp: sql<number>`count(*) filter (where ${cases.is_claim} is true and ${cases.channel} = 'whatsapp')::int`,
      reclamos_mail: sql<number>`count(*) filter (where ${cases.is_claim} is true and ${cases.channel} = 'email')::int`,
      // Por situación de hoy y por día de apertura: sale del propio caso, sin recorrer la auditoría.
      escalados: sql<number>`count(*) filter (where ${inArray(cases.status, [...ESTADOS_ESCALADO])})::int`,
      listos: sql<number>`count(*) filter (where ${inArray(cases.status, [...ESTADOS_COMPLETADO_SIN_PERSONA])})::int`,
      cerrados: sql<number>`count(*) filter (where ${esCierre})::int`,
    })
    .from(cases)
    .where(and(gte(cases.created_at, desde), inArray(cases.channel, [...CANALES_REALES])))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
}

// Un cierre es `cerrado`, `pagado` o `rechazado`; los tres guardan su fecha en `closed_at`.
const esCierre = inArray(cases.status, [...ESTADOS_CERRADOS]);

/** Un solo conteo; sólo canales reales (whatsapp, email, web), como la serie. */
export function consultaDeAyer(db: ClienteDatos, desde: string, hasta: string) {
  const creadoAyer = and(gte(cases.created_at, desde), lt(cases.created_at, hasta));
  return db
    .select({
      reclamos: sql<number>`count(*) filter (where ${creadoAyer} and ${cases.is_claim} is true)::int`,
      whatsapps: sql<number>`count(*) filter (where ${creadoAyer} and ${cases.channel} = 'whatsapp')::int`,
      mails: sql<number>`count(*) filter (where ${creadoAyer} and ${cases.channel} = 'email')::int`,
      escalados: sql<number>`count(*) filter (where ${creadoAyer} and ${inArray(cases.status, [...ESTADOS_ESCALADO])})::int`,
      cerrados: sql<number>`count(*) filter (where ${esCierre} and ${and(gte(cases.closed_at, desde), lt(cases.closed_at, hasta))})::int`,
      para_responder: sql<number>`count(*) filter (where ${cases.para_responder_desde} is not null)::int`,
      confirmacion_pendiente: sql<number>`count(*) filter (where ${cases.status} = 'confirmacion_pendiente')::int`,
    })
    .from(cases)
    .where(inArray(cases.channel, [...CANALES_REALES]));
}

/**
 * Todo lo que muestra la pantalla, para un inquilino.
 *
 * Las tarjetas, las distribuciones por estado y tipo, el ciclo y los cuellos de
 * botella miran el `periodo` elegido (el mes por omisión); el uso de IA sigue
 * siendo el del mes calendario, que es el que se factura.
 *
 * `serie` agrega la consulta de actividad al MISMO lote, así la pantalla sigue
 * en un viaje. Sin ella no se lee y vuelve null. `ayer` hace lo mismo con el
 * resumen del día anterior. El mes a mes de los últimos doce meses no va acá:
 * recorre la auditoría de todo el año, y quien lo pide no necesita nada de lo
 * demás (ver `getHistorialDeMetricas`).
 */
export async function getTenantKpis(
  tenantCtx: TenantContext,
  opts?: { serie?: Unidad; ayer?: boolean; periodo?: Periodo }
): Promise<MetricasData> {
  /*
   * ── La ventana del mes, en horario argentino ────────────────────────────────
   *
   * Esto era `new Date(now.getFullYear(), now.getMonth(), 1)`, que arma la
   * medianoche del primero en la zona del PROCESO. En una máquina argentina da
   * bien; en Vercel, que corre en UTC, da las 21:00 del último día del mes
   * anterior. O sea que el panel de septiembre traía adentro las últimas tres
   * horas de agosto, y no había forma de verlo desde acá.
   */
  // Uno solo para la consulta y el relleno: si cambia el día entre los dos, la
  // ventana leída y la dibujada no coinciden.
  const ahora = new Date();
  const { inicio: monthStart, fin: monthEnd } = mesArgentino(ahora);
  const periodo = opts?.periodo ?? PERIODO_POR_DEFECTO;
  const { desde, hasta } = rangoDelPeriodo(periodo, ahora);

  type Usos = {
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    cost_usd: number;
  };

  const [
    [resumenMes],
    byStatusRows,
    byTypeRows,
    [escalatedRow],
    topAnalystsRows,
    [usageMonthRow],
    [usageAllTimeRow],
    usageByUserRows,
    usageByModelRows,
    [cicloRow],
    cuellosRows,
    ...opcionales
  /*
   * Once consultas —hasta trece con la serie y ayer— en UN viaje, no en once.
   *
   * Estaba en `Promise.all([enTenant(...), enTenant(...), ...])`, que las pone
   * en paralelo pero NO las junta: cada `enTenant` abre su propio `batch()` con
   * su `set_config` adelante, o sea una transaccion HTTP entera contra Neon por
   * consulta. Nueve idas y vueltas para armar una pantalla.
   *
   * `enTenantVarias` las manda en un solo lote. La ejecucion de estas consultas
   * se mide en milisegundos; lo que se paga es la distancia, y ahora se paga
   * una vez.
   *
   * Las formas van escritas porque `enTenantVarias` no las puede inferir del
   * armador: sin la tupla, todo vuelve como `unknown`.
   */
  ] = await enTenantVarias<
    [
      [{ total: number; listo: number; respondidos: number; minutos: number }],
      Array<{ status: string; n: number }>,
      Array<{ claim_type: string | null; n: number }>,
      [{ n: number }],
      Array<{ assigned_to: string | null; full_name: string | null; n: number }>,
      [Usos],
      [Usos],
      Array<Usos & { user_id: string | null; full_name: string | null; email: string | null }>,
      Array<Usos & { model: string }>,
      [FilaDeCiclo],
      Array<FilaDeCuello>,
      ...Array<PuntoSerie[] | ResumenDeAyer[]>,
    ]
  >(tenantCtx, (db) => {
    /*
     * La primera respuesta de VERDAD: el envío más viejo en el canal de
     * salida, no la apertura del caso. `avg_opening_time_minutes` medía
     * cuánto tardaba el agente en abrir el caso, que es instantáneo — el
     * número que importa es cuánto tarda alguien en contestarle al
     * denunciante.
     */
    const primera = sql`(select min(om.created_at) from outbound_messages om where om.case_id = ${cases.id} and om.tenant_id = ${cases.tenant_id} and om.status = 'sent')`;
    return [
      /*
       * Los tres números del mes en una fila, en vez de traer los casos.
       *
       * Esto devolvía una fila por caso del mes —455 en producción— para
       * contarlas en JS. La suma y el promedio los sabe hacer la base, y lo
       * que viaja pasa de cientos de filas a una.
       *
       * `sum` y `count` por separado y la división en JS a propósito: así el
       * redondeo es exactamente el mismo `Math.round(total / n)` de antes, y
       * el número que ve la pantalla no se mueve.
       */
      db
          .select({
            total: sql<number>`count(*)::int`,
            // Completado por una persona, o ya enviado al Core — nunca el
            // `listo` legado, que no dice que alguien lo haya mirado.
            listo: sql<number>`count(*) filter (where ${completadoConfirmado})::int`,
            respondidos: sql<number>`count(${primera})::int`,
            minutos: sql<number>`coalesce(sum(extract(epoch from (${primera} - ${cases.created_at})) / 60), 0)::float8`,
          })
          .from(cases)
          .where(and(
            gte(cases.created_at, desde),
            lt(cases.created_at, hasta),
          )),
      // Agrupado en la base: traía las 458 filas de `cases` para contarlas.
      db
          .select({ status: cases.status, n: sql<number>`count(*)::int` })
          .from(cases)
          .where(and(gte(cases.created_at, desde), lt(cases.created_at, hasta)))
          .groupBy(cases.status),
      // Idem, y el `is not null` reemplaza al `if (row.claim_type)` que
      // descartaba esas filas después de haberlas traído. `is_claim is true`
      // saca los `no_relevante`, que traen un `claim_type` del intento previo
      // y antes se contaban como si fueran reclamos.
      db
          .select({ claim_type: cases.claim_type, n: sql<number>`count(*)::int` })
          .from(cases)
          .where(and(
            isNotNull(cases.claim_type),
            sql`${cases.is_claim} is true`,
            gte(cases.created_at, desde),
            lt(cases.created_at, hasta),
          ))
          .groupBy(cases.claim_type),
      db
          .select({ n: count() })
          .from(cases)
          .where(and(
            // Idem: el canal real escribe `requiere_especialista`.
            inArray(cases.status, [...ESTADOS_ESCALADO]),
            gte(cases.created_at, desde),
            lt(cases.created_at, hasta),
          )),
      /*
       * Los cinco de arriba, contados y ordenados por la base.
       *
       * El desempate por nombre es nuevo y deliberado: el `.sort()` de JS es
       * estable sobre el orden en que llegaron las filas, y un `order by`
       * sin criterio secundario no. Sin esto, dos analistas con la misma
       * cantidad podían intercambiarse entre dos cargas de la pantalla.
       */
      db
          .select({
            assigned_to: cases.assigned_to,
            full_name: users.full_name,
            n: sql<number>`count(*)::int`,
          })
          .from(cases)
          .leftJoin(users, eq(cases.assigned_to, users.id))
          .where(and(
            esCierre,
            gte(cases.closed_at, desde),
            lt(cases.closed_at, hasta),
            isNotNull(cases.assigned_to),
          ))
          .groupBy(cases.assigned_to, users.full_name)
          .orderBy(sql`count(*) desc, ${users.full_name} asc`)
          .limit(5),
      db
          .select({
            calls: count(),
            prompt_tokens: sql<number>`coalesce(sum(${aiUsage.prompt_tokens}), 0)::float8`,
            completion_tokens: sql<number>`coalesce(sum(${aiUsage.completion_tokens}), 0)::float8`,
            cost_usd: sql<number>`coalesce(sum(${aiUsage.cost_usd}), 0)::float8`,
          })
          .from(aiUsage)
          .where(and(
            gte(aiUsage.created_at, monthStart),
            lt(aiUsage.created_at, monthEnd),
          )),
      db
          .select({
            calls: count(),
            prompt_tokens: sql<number>`coalesce(sum(${aiUsage.prompt_tokens}), 0)::float8`,
            completion_tokens: sql<number>`coalesce(sum(${aiUsage.completion_tokens}), 0)::float8`,
            cost_usd: sql<number>`coalesce(sum(${aiUsage.cost_usd}), 0)::float8`,
          })
          .from(aiUsage),
      db
          .select({
            user_id: aiUsage.user_id,
            full_name: users.full_name,
            email: authUsers.email,
            calls: count(),
            prompt_tokens: sql<number>`coalesce(sum(${aiUsage.prompt_tokens}), 0)::float8`,
            completion_tokens: sql<number>`coalesce(sum(${aiUsage.completion_tokens}), 0)::float8`,
            cost_usd: sql<number>`coalesce(sum(${aiUsage.cost_usd}), 0)::float8`,
          })
          .from(aiUsage)
          .leftJoin(users, eq(users.id, aiUsage.user_id))
          .leftJoin(authUsers, eq(authUsers.id, aiUsage.user_id))
          .where(and(
            gte(aiUsage.created_at, monthStart),
            lt(aiUsage.created_at, monthEnd),
          ))
          .groupBy(aiUsage.user_id, users.full_name, authUsers.email),
      db
          .select({
            model: aiUsage.model,
            calls: count(),
            prompt_tokens: sql<number>`coalesce(sum(${aiUsage.prompt_tokens}), 0)::float8`,
            completion_tokens: sql<number>`coalesce(sum(${aiUsage.completion_tokens}), 0)::float8`,
            cost_usd: sql<number>`coalesce(sum(${aiUsage.cost_usd}), 0)::float8`,
          })
          .from(aiUsage)
          .where(and(
            gte(aiUsage.created_at, monthStart),
            lt(aiUsage.created_at, monthEnd),
          ))
          .groupBy(aiUsage.model),
      consultaDeCiclo(db, desde, hasta),
      consultaDeCuellos(db, desde, hasta),
      ...(opts?.serie
        ? [consultaDeActividad(db, opts.serie, desdeDe(opts.serie, ahora))]
        : []),
      ...(opts?.ayer
        ? [consultaDeAyer(db, medianocheHaceDias(2, ahora), medianocheHaceDias(1, ahora))]
        : []),
    ];
  });

  const serieFilas = opts?.serie ? (opcionales.shift() as PuntoSerie[] | undefined) : undefined;
  const ayerFilas = opts?.ayer ? (opcionales.shift() as ResumenDeAyer[] | undefined) : undefined;

  const totalCasesMonth = resumenMes?.total ?? 0;

  // El mismo Math.round(total / n) de antes, con la suma hecha por la base.
  const avgFirstResponseMinutes: number | null =
    resumenMes && resumenMes.respondidos > 0
      ? Math.round(resumenMes.minutos / resumenMes.respondidos)
      : null;

  const listoCount = resumenMes?.listo ?? 0;
  const completadoConfirmadoRate =
    totalCasesMonth > 0 ? Math.round((listoCount / totalCasesMonth) * 100) : 0;

  const byStatus: Record<string, number> = {};
  for (const row of byStatusRows) byStatus[row.status] = row.n;

  const byType: Record<string, number> = {};
  for (const row of byTypeRows) {
    if (row.claim_type) byType[row.claim_type] = row.n;
  }
  // Los nueve tipos del esquema, no los cuatro de cuando esto se escribió.
  // Sembrar sólo cuatro dejaba a cristales, RC, robo de contenido,
  // accidente personal y `other` fuera del gráfico salvo que hubiera casos,
  // así que la distribución se leía como si esos tipos no existieran.
  for (const t of ClaimTypeSchema.options) {
    if (!(t in byType)) byType[t] = 0;
  }

  // Sólo estados que el esquema conoce: el nombre sale de un payload de auditoría.
  const cuellos = cuellosRows
    .filter((row) => Object.hasOwn(FSM_TRANSITIONS, row.estado))
    .map((row) => ({ ...row, horas_promedio: unDecimal(row.horas_promedio) ?? 0 }));

  const topAnalysts = topAnalystsRows.map((row) => ({
    full_name: row.full_name ?? "Analista",
    closed_count: row.n,
  }));

  const usageByUser: AiUsageByUser[] = usageByUserRows
    .map((row) => ({
      user_id: row.user_id,
      full_name: row.full_name ?? "Sistema",
      email: row.email ?? (row.user_id ? "" : "Procesos automáticos"),
      ...normalizeUsage(row),
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .slice(0, 8);

  const usageByModel: AiUsageByModel[] = usageByModelRows
    .map((row) => ({
      model: row.model,
      ...normalizeUsage(row),
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens);

  return {
    summary: {
      total_cases_month: totalCasesMonth,
      avg_first_response_minutes: avgFirstResponseMinutes,
      completado_confirmado_rate: completadoConfirmadoRate,
      escalated_count: escalatedRow?.n ?? 0,
      sin_intervencion_rate: porcentaje(cicloRow?.sin_intervencion ?? 0, cicloRow?.reclamos ?? 0),
      mensajes_por_caso: unDecimal(cicloRow?.mensajes_por_caso),
      ciclo: {
        mediana_horas_listo: unDecimal(cicloRow?.mediana_horas_listo),
        casos_listo: cicloRow?.con_listo ?? 0,
        mediana_horas_cierre: unDecimal(cicloRow?.mediana_horas_cierre),
        casos_cierre: cicloRow?.con_cierre ?? 0,
      },
      cuellos,
    },
    by_status: byStatus,
    by_type: byType,
    top_analysts: topAnalysts,
    ai_usage: {
      month: normalizeUsage(usageMonthRow),
      all_time: normalizeUsage(usageAllTimeRow),
      by_user: usageByUser,
      by_model: usageByModel,
    },
    period: { start: desde, end: hasta },
    periodo,
    serie: opts?.serie
      ? completarSerie(opts.serie, ahora, serieFilas ?? [])
      : null,
    ...(opts?.ayer ? { ayer: ayerFilas?.[0] ?? null } : {}),
  };
}
