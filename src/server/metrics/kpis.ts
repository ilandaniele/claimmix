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

import { and, eq, gte, inArray, isNotNull, lt, sql, type AnyColumn, type SQL } from "drizzle-orm";
import {
  ESTADOS_CERRADOS,
  ESTADOS_COMPLETADO_SIN_PERSONA,
  ESTADOS_ESCALADO,
  FSM_TRANSITIONS,
  type CaseStatus,
} from "@/core/case/fsm";

import { diaArgentino, medianocheHaceDias, ZONA_ARGENTINA } from "@/core/fecha/dia-argentino";
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
import { aiUsageMensual, authUsers, cases, outboundMessages, users } from "@/lib/db/schema";
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
  /** El rango del período elegido, `[start, end)`. El uso de IA sigue el mes argentino, el mismo del guardia del gasto. */
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
 * Las cuatro sumas del acumulador `ai_usage_mensual` (0046), de las filas que
 * cumplan `filtro` si lo hay. `float8` para que vuelvan como número, no como texto.
 */
const usoSumado = (filtro?: SQL) => {
  const de = (columna: AnyColumn) =>
    sql<number>`coalesce(sum(${columna})${filtro ? sql` filter (where ${filtro})` : sql.empty()}, 0)::float8`;
  return {
    calls: de(aiUsageMensual.calls),
    prompt_tokens: de(aiUsageMensual.prompt_tokens),
    completion_tokens: de(aiUsageMensual.completion_tokens),
    cost_usd: de(aiUsageMensual.cost_usd),
  };
};

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
 * siendo el del mes argentino, el mismo con el que cuenta el guardia del gasto.
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
  // El acumulador de IA (0046) guarda el mes como su primer día en hora argentina.
  const mesIa = `${diaArgentino(ahora).slice(0, 7)}-01`;
  const periodo = opts?.periodo ?? PERIODO_POR_DEFECTO;
  const { desde, hasta } = rangoDelPeriodo(periodo, ahora);

  type Usos = {
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    cost_usd: number;
  };

  const [
    porEstadoRows,
    topAnalystsRows,
    usoRows,
    [cicloRow],
    cuellosRows,
    ...opcionales
  /*
   * Cinco consultas —hasta siete con la serie y ayer— en UN viaje, no en cinco.
   *
   * Estaba en `Promise.all([enTenant(...), enTenant(...), ...])`, que las pone
   * en paralelo pero NO las junta: cada `enTenant` abre su propio `batch()` con
   * su `set_config` adelante, o sea una transaccion HTTP entera contra Neon por
   * consulta. Nueve idas y vueltas para armar una pantalla.
   *
   * `enTenantVarias` las manda en un solo lote. La ejecucion de estas consultas
   * se mide en milisegundos; lo que se paga es la distancia, y ahora se paga
   * una vez. Dentro del lote cada sentencia también cuesta su ida y vuelta
   * hasta la base, y con veinte analistas a la vez eso pesa: por eso eran trece
   * y son siete.
   *
   * Las formas van escritas porque `enTenantVarias` no las puede inferir del
   * armador: sin la tupla, todo vuelve como `unknown`.
   */
  ] = await enTenantVarias<
    [
      Array<{
        por_tipo: number;
        status: CaseStatus | null;
        claim_type: string | null;
        n: number;
        reclamos: number;
        listo: number;
        respondidos: number;
        minutos: number;
      }>,
      Array<{ assigned_to: string | null; full_name: string | null; n: number }>,
      Array<{
        grupo: number;
        user_id: string | null;
        full_name: string | null;
        email: string | null;
        model: string | null;
        mes: Usos;
        total: Usos;
      }>,
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
     *
     * Lateral y no subconsulta en el SELECT: la leen dos agregados, y escrita
     * dos veces Postgres la corría dos veces por caso.
     */
    const primera = db
      .select({ en: sql<string>`min(${outboundMessages.created_at})`.as("en") })
      .from(outboundMessages)
      .where(and(eq(outboundMessages.case_id, cases.id), eq(outboundMessages.status, "sent")))
      .as("primera");
    return [
      /*
       * Todo lo que sale de los casos del período, agrupado por estado y por
       * tipo en la misma pasada: la distribución, y sumando los grupos de
       * estado, el total, los escalados, lo completado y la primera respuesta.
       * `por_tipo` dice de qué agrupación es cada fila.
       *
       * Antes eran cuatro consultas sobre las mismas filas, y antes todavía
       * una fila por caso —455 en producción— para contarlas en JS.
       *
       * `sum` y `count` por separado y la división en JS a propósito: así el
       * redondeo es exactamente el mismo `Math.round(total / n)` de antes, y
       * el número que ve la pantalla no se mueve.
       */
      db
          .select({
            por_tipo: sql<number>`grouping(${cases.status})::int`,
            status: cases.status,
            claim_type: cases.claim_type,
            n: sql<number>`count(*)::int`,
            // `is_claim is true` saca de la distribución por tipo a los
            // `no_relevante`, que traen un `claim_type` del intento previo.
            reclamos: sql<number>`count(*) filter (where ${cases.is_claim} is true)::int`,
            // Completado por una persona, o ya enviado al Core — nunca el
            // `listo` legado, que no dice que alguien lo haya mirado.
            listo: sql<number>`count(*) filter (where ${completadoConfirmado})::int`,
            respondidos: sql<number>`count(${primera.en})::int`,
            minutos: sql<number>`coalesce(sum(extract(epoch from (${primera.en} - ${cases.created_at})) / 60), 0)::float8`,
          })
          .from(cases)
          .leftJoinLateral(primera, sql`true`)
          .where(and(gte(cases.created_at, desde), lt(cases.created_at, hasta)))
          .groupBy(sql`grouping sets ((${cases.status}), (${cases.claim_type}))`),
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
      /*
       * El uso de IA en una pasada por el acumulador: por persona y por modelo
       * del mes, y el mes y el total histórico. `grupo` dice de qué
       * agrupación es cada fila (1 persona, 2 modelo, 3 los totales); sin él,
       * el `user_id` nulo de los procesos automáticos no se distingue del
       * nulo de una fila que no agrupa por persona.
       */
      db
          .select({
            grupo: sql<number>`grouping(${aiUsageMensual.user_id}, ${aiUsageMensual.model})::int`,
            user_id: aiUsageMensual.user_id,
            full_name: users.full_name,
            email: authUsers.email,
            model: aiUsageMensual.model,
            mes: usoSumado(eq(aiUsageMensual.mes, mesIa)),
            total: usoSumado(),
          })
          .from(aiUsageMensual)
          .leftJoin(users, eq(users.id, aiUsageMensual.user_id))
          .leftJoin(authUsers, eq(authUsers.id, aiUsageMensual.user_id))
          .groupBy(sql`grouping sets ((${aiUsageMensual.user_id}, ${users.full_name}, ${authUsers.email}), (${aiUsageMensual.model}), ())`),
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

  const byStatus: Record<string, number> = {};
  let totalCasesMonth = 0;
  let listoCount = 0;
  let respondidos = 0;
  let minutos = 0;
  let escalados = 0;
  const byType: Record<string, number> = {};
  for (const row of porEstadoRows) {
    if (row.por_tipo) {
      if (row.claim_type && row.reclamos > 0) byType[row.claim_type] = row.reclamos;
      continue;
    }
    if (!row.status) continue;
    byStatus[row.status] = row.n;
    totalCasesMonth += row.n;
    listoCount += row.listo;
    respondidos += row.respondidos;
    minutos += row.minutos;
    if (ESTADOS_ESCALADO.has(row.status)) escalados += row.n;
  }

  // El mismo Math.round(total / n) de antes, con la suma hecha por la base.
  const avgFirstResponseMinutes: number | null =
    respondidos > 0 ? Math.round(minutos / respondidos) : null;

  const completadoConfirmadoRate =
    totalCasesMonth > 0 ? Math.round((listoCount / totalCasesMonth) * 100) : 0;

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

  // Por persona y por modelo, sólo quien usó IA este mes.
  const delMes = (grupo: number) => usoRows.filter((row) => row.grupo === grupo && row.mes.calls > 0);
  const usageRow = usoRows.find((row) => row.grupo === 3);

  const usageByUser: AiUsageByUser[] = delMes(1)
    .map((row) => ({
      user_id: row.user_id,
      full_name: row.full_name ?? "Sistema",
      email: row.email ?? (row.user_id ? "" : "Procesos automáticos"),
      ...normalizeUsage(row.mes),
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .slice(0, 8);

  const usageByModel: AiUsageByModel[] = delMes(2)
    .map((row) => ({
      model: row.model ?? "",
      ...normalizeUsage(row.mes),
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens);

  return {
    summary: {
      total_cases_month: totalCasesMonth,
      avg_first_response_minutes: avgFirstResponseMinutes,
      completado_confirmado_rate: completadoConfirmadoRate,
      escalated_count: escalados,
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
      month: normalizeUsage(usageRow?.mes),
      all_time: normalizeUsage(usageRow?.total),
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
