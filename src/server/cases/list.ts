/**
 * Cases list query — `GET /api/cases`.
 *
 * Builds the Drizzle query for the cases listing endpoint.
 * Tenant isolation is enforced by an explicit tenant_id filter via enTenant,
 * backed by RLS (FORCE ROW LEVEL SECURITY) as the DB-level backstop:
 *   - IDOR: not applicable to list — users only see their tenant's rows
 *
 * AC9:  List is isolated by tenant_id.
 * AC11: Filter by claim type returns only matching cases.
 * AC12: Pagination per_page is capped at 100.
 */

import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { estadosAConsultar } from "@/core/case/filtro-de-estado";
import { ESTADOS_CERRADOS, ESTADOS_ESCALADO, ESTADOS_ESPERANDO_AL_DENUNCIANTE } from "@/core/case/fsm";
import { limitesDelFiltro } from "@/core/case/plazos";
import { RANGOS } from "@/core/case/puntaje-complejidad";
import { medianocheHaceDias } from "@/core/fecha/dia-argentino";
import { escapeLike, ilikeAny } from "@/lib/db/helpers";
import {
  enTenant,
  enTenantVarias,
  type ClienteDatos,
  type TenantContext,
} from "@/data/scope";
import { cases } from "@/lib/db/schema";
import type { CaseRow as CasesTableRow } from "@/lib/db/types";
import type { CaseQuery, Periodo, SortColumn } from "@/lib/schemas/cases";
import { errorCode } from "@/lib/observability/error-code";

/**
 * La fila que devuelve este listado: las columnas de `cases` más lo que
 * `consultaListado` suma por subconsulta correlacionada, `fecha_siniestro` y
 * `replied_at`. No es la fila cruda de la tabla: esa sigue siendo `CaseRow`
 * en `@/lib/db/types`, y la sigue usando el resto del código (detalle de un
 * caso, patch, orquestación) donde no hay tal subconsulta.
 */
export type CaseRow = CasesTableRow & {
  fecha_siniestro: string | null;
  assigned_name: string | null;
  replied_at: string | null;
};

export interface CaseListResult {
  data: CaseRow[];
  meta: {
    total: number;
    page: number;
    per_page: number;
    pages: number;
  };
}

/**
 * El plazo sólo corre mientras el caso está abierto. El UPDATE de estado limpia
 * `vence_en` al cerrar, pero el barrido de abandono y el respaldo que corre sin
 * la 0042 no lo tocan, y un caso cerrado con plazo puesto aparecería vencido en
 * la bandeja, el filtro y el orden. Leerlo así evita depender de quién cerró.
 */
const vencimientoVigente = sql<string | null>`case when ${cases.status} not in ${[...ESTADOS_CERRADOS]} then ${cases.vence_en} end`;

/** Whitelisted sort columns (SortColumnSchema prevents arbitrary input). */
const SORT_COLUMNS = {
  created_at: cases.created_at,
  confidence_min: cases.confidence_min,
  status: cases.status,
  puntaje_complejidad: cases.puntaje_complejidad,
  vence_en: vencimientoVigente,
} as const satisfies Record<SortColumn, unknown>;

/**
 * Las dos columnas que están vacías en la mayoría de los casos —los anteriores
 * a la 0042 y los que ya no corren plazo— y por eso van al final en cualquier
 * dirección: un ascendente por vencimiento que abriera con mil casos sin plazo
 * taparía el que vence mañana. Las demás columnas se ordenan como siempre, para
 * no cambiar los planes que ya usan sus índices.
 */
const ORDEN_CON_NULOS_AL_FINAL: ReadonlySet<SortColumn> = new Set(["puntaje_complejidad", "vence_en"]);

/**
 * El WHERE de un listado de casos, a partir de los filtros de la consulta.
 *
 * Existe porque estaba escrito dos veces y las dos copias divergieron:
 * `listCasesForExport` se quedó con status/type/q y nunca recibió los cinco
 * que se agregaron después —severidad, canal, is_claim, cliente y póliza—
 * aunque su propio contrato dice «acepta los mismos filtros que listCases».
 *
 * El síntoma lo veía el usuario: filtrar la bandeja por críticos y tocar
 * Exportar bajaba mil filas de todas las severidades, sin ningún aviso.
 *
 * Acá NO va `eq(cases.tenant_id, …)`. Lo pone la base, a partir del contexto
 * que viaja con el lote. Si alguna vez volviera a aparecer escrito a mano,
 * sería redundante y —peor— haría pensar que sin él la consulta filtraría de
 * menos, cuando lo que pasaría es que no devolvería nada.
 */
export function buildCaseFilters(
  query: Omit<CaseQuery, "page" | "per_page" | "sort" | "order">,
  yo?: string,
  // Parámetro para que el conteo y el listado midan contra el mismo instante.
  ahora: Date = new Date()
): SQL | undefined {
  const {
    status,
    type,
    q,
    desde,
    severity,
    fraude,
    customer_id,
    policy_id,
    channel,
    vencimiento,
    complejidad,
    is_claim,
    para_responder,
    cola,
  } = query;
  const conditions: (SQL | undefined)[] = [];

  /*
   * `inArray` y no `eq`: las cinco opciones de la bandeja son GRUPOS, y ahora
   * cada filtro es una lista — se puede pedir «choque» y «robo» a la vez.
   *
   * «Escalado» son `escalado` y `requiere_especialista`, y el canal real sólo
   * escribe el segundo. Con `eq` el chip decía 43 y devolvía 1. El porqué de
   * cada grupo está en `filtro-de-estado.ts`. Con varios chips de estado, la
   * consulta es la UNIÓN de sus grupos, sin repetidos (de ahí el `Set`).
   *
   * Un estado suelto que no sea una de las cinco claves sigue funcionando: la
   * función devuelve ese solo, así que `?status=requiere_especialista` pide
   * exactamente eso. La API la usan el CSV y el sondeo en vivo.
   *
   * `?.length` y no sólo el valor: una lista vacía tiene que significar SIN
   * filtro, nunca `inArray(col, [])` — eso en Postgres no empareja ninguna
   * fila, y vaciaría la bandeja entera sin ningún aviso.
   */
  if (status?.length)
    conditions.push(
      inArray(cases.status, [...new Set(status.flatMap(estadosAConsultar))])
    );
  if (type?.length) conditions.push(inArray(cases.claim_type, type));
  if (q) {
    const patron = `%${escapeLike(q)}%`;
    const condicionesTexto: (SQL | undefined)[] = [
      // Case-insensitive substring search on policyholder_name and policy_number.
      // Parameterized via Drizzle — no raw SQL string interpolation.
      ilikeAny([cases.policyholder_name, cases.policy_number], q),
      /*
       * El nombre que ve la tabla cuando la fila no tiene `policyholder_name`
       * propio: sale de `extracted_fields`, coalescido recién en
       * `consultaListado`. Sin este EXISTS, buscar por ese nombre no
       * encontraba la fila — aunque fuera lo único que se veía en pantalla.
       */
      sql`exists (
        select 1 from extracted_fields ef
         where ef.case_id = ${cases.id}
           and ef.tenant_id = ${cases.tenant_id}
           and ef.field_key = 'full_name'
           and ef.field_value ilike ${patron}
      )`,
    ];
    /*
     * «SIN-1234-abcd», con o sin guiones: el número de caso que muestra la
     * pantalla (`formatCaseId`, en CasesTable), no una columna de la fila.
     */
    const comoNumero = /^(sin-?)?([0-9a-f]{4})-?([0-9a-f]{4})$/i.exec(q.trim());
    if (comoNumero) {
      const hex8 = (comoNumero[2] + comoNumero[3]).toLowerCase();
      condicionesTexto.push(sql`right(replace(${cases.id}::text, '-', ''), 8) = ${hex8}`);
    }
    conditions.push(or(...condicionesTexto));
  }
  if (desde) conditions.push(gte(cases.created_at, desde));
  // AC18: Email-intake filters
  if (severity?.length) conditions.push(inArray(cases.severity, severity));
  // G35: filtro de fraude de la bandeja.
  if (fraude?.length) conditions.push(inArray(cases.fraud_risk_level, fraude));
  if (customer_id) conditions.push(eq(cases.customer_id, customer_id));
  if (policy_id) conditions.push(eq(cases.policy_id, policy_id));
  if (channel?.length) conditions.push(inArray(cases.channel, channel));
  /*
   * B10: cada opción es un rango de `vence_en` y varias son la unión. Un caso sin
   * plazo (`vence_en` nulo) no cae en ningún rango: la comparación con NULL no
   * es verdadera, así que no hace falta preguntar por él. Un caso cerrado no
   * cuenta aunque conserve el plazo (ver `vencimientoVigente`).
   */
  if (vencimiento?.length)
    conditions.push(
      and(
        notInArray(cases.status, [...ESTADOS_CERRADOS]),
        or(
          ...vencimiento.map((filtro) => {
            const { desde, hasta } = limitesDelFiltro(filtro, ahora);
            return and(desde ? gte(cases.vence_en, desde) : undefined, lt(cases.vence_en, hasta));
          })
        )
      )
    );
  // B13: las bandas son rangos cerrados del puntaje; `RANGOS` es la única fuente.
  if (complejidad?.length)
    conditions.push(
      or(
        ...complejidad.map((banda) =>
          and(
            gte(cases.puntaje_complejidad, RANGOS[banda].desde),
            lte(cases.puntaje_complejidad, RANGOS[banda].hasta)
          )
        )
      )
    );
  if (is_claim !== undefined) conditions.push(eq(cases.is_claim, is_claim));
  if (para_responder) conditions.push(isNotNull(cases.para_responder_desde));
  /*
   * «Mi cola»: lo escalado sin asignar o asignado a mí, más lo que espera al
   * denunciante hace más de 48 horas — ahí ya no importa quién lo tenga, nadie
   * lo está mirando. Sin `yo` (sesión sin id resuelto) cierra en falso: mejor
   * una cola vacía que una que muestre casos de cualquiera.
   */
  if (cola === "mia")
    conditions.push(
      yo
        ? or(
            and(
              inArray(cases.status, [...ESTADOS_ESCALADO]),
              or(isNull(cases.assigned_to), eq(cases.assigned_to, yo))
            ),
            and(
              inArray(cases.status, [...ESTADOS_ESPERANDO_AL_DENUNCIANTE, "confirmacion_pendiente"]),
              lt(cases.updated_at, sql`now() - interval '48 hours'`)
            )
          )!
        : sql`false`
    );

  // `and()` sin condiciones devuelve undefined, que para drizzle es «sin WHERE».
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** Cuántos días entran en cada opción del selector de período, hoy incluido. */
const DIAS_POR_PERIODO: Record<Periodo, number> = { hoy: 1, "7d": 7, "30d": 30, "90d": 90 };

/**
 * La medianoche argentina desde la que arranca un `periodo` de la bandeja.
 *
 * `undefined` es «todo el tiempo», la opción que no manda `periodo` por la
 * URL. `cuando` es parámetro y no `new Date()` fijo adentro, igual que el
 * resto de `dia-argentino.ts`, para que un test pueda fijar el reloj.
 */
export function desdeDePeriodo(periodo: Periodo | undefined, cuando: Date = new Date()): string | undefined {
  return periodo ? medianocheHaceDias(DIAS_POR_PERIODO[periodo], cuando) : undefined;
}

/**
 * Las consultas que abre la bandeja, como consultas y no como resultados.
 *
 * Se exportan porque la prueba de carga necesita pedirle a Postgres el plan de
 * ÉSTAS. Antes explicaba un `select id from cases where tenant_id = '…' order by
 * created_at desc limit 25` escrito a mano adentro del script: otro rol, otro
 * predicado —acá el filtro por inquilino lo pone RLS— y sin las tres
 * subconsultas correlacionadas ni el conteo. O sea que el listado podía pasar a
 * recorrer la tabla entera con el chequeo en verde.
 *
 * Un armador compartido es la única forma de que el plan que se explica sea el
 * plan que corre.
 */
export function consultaListado(datos: ClienteDatos, query: CaseQuery, yo?: string, ahora: Date = new Date()) {
  const { page, per_page, sort, order } = query;
  const sortColumn = SORT_COLUMNS[sort];
  // En «Para responder» va primero el que espera hace más tiempo. El índice
  // parcial de la 0031 sirve este orden recorrido al revés. En «Mi cola» el
  // más viejo también va primero: es el que lleva más tiempo sin que nadie lo
  // mire.
  const orden: SQL[] = query.para_responder
    ? [asc(cases.para_responder_desde)]
    : query.cola === "mia"
      ? [asc(cases.updated_at)]
      : ORDEN_CON_NULOS_AL_FINAL.has(sort)
        ? // Muchos casos comparten puntaje o plazo: sin desempate, dos páginas seguidas pueden repetir o saltear filas.
          [sql`${sortColumn} ${order === "asc" ? sql`asc` : sql`desc`} nulls last`, asc(cases.id)]
        : [order === "asc" ? asc(sortColumn) : desc(sortColumn)];
  return datos
    .select({
      id: cases.id,
      tenant_id: cases.tenant_id,
      // Fallback inline: a second round-trip fired on nearly every render.
      policy_number: sql<string | null>`coalesce(${cases.policy_number}, (
          select ef.field_value from extracted_fields ef
           where ef.case_id = ${cases.id}
             and ef.tenant_id = ${cases.tenant_id}
             and ef.field_key = 'policy_number'
        ))`,
      policyholder_name: sql<string | null>`coalesce(${cases.policyholder_name}, (
          select ef.field_value from extracted_fields ef
           where ef.case_id = ${cases.id}
             and ef.tenant_id = ${cases.tenant_id}
             and ef.field_key = 'full_name'
        ))`,
      // No hay columna `cases.incident_date` con la que hacer coalesce — el
      // dato vive solo en `extracted_fields`. La clave real es `accident_date`:
      // `fecha_siniestro` es el alias en español que a veces emite el
      // extractor, y `canonicalFieldKey` (claim-fields.ts) lo mapea a esta.
      fecha_siniestro: sql<string | null>`(
          select ef.field_value from extracted_fields ef
           where ef.case_id = ${cases.id}
             and ef.tenant_id = ${cases.tenant_id}
             and ef.field_key = 'accident_date'
        )`,
      claim_type: cases.claim_type,
      status: cases.status,
      confidence_min: cases.confidence_min,
      assigned_to: cases.assigned_to,
      channel: cases.channel,
      created_at: cases.created_at,
      updated_at: cases.updated_at,
      closed_at: cases.closed_at,
      // Email-intake columns (0005, 0006)
      severity: cases.severity,
      customer_id: cases.customer_id,
      policy_id: cases.policy_id,
      is_claim: cases.is_claim,
      requires_specialist: cases.requires_specialist,
      para_responder_desde: cases.para_responder_desde,
      // Sólo para el equipo (B10, B13): la pantalla los pinta, nada de esto sale al asegurado.
      vence_en: vencimientoVigente,
      puntaje_complejidad: cases.puntaje_complejidad,
      // Qué pide el último mensaje (B3): sólo mientras el caso espera respuesta.
      mensaje_tardio_tipo: sql<string | null>`case when ${cases.para_responder_desde} is not null then ${cases.mensaje_tardio_tipo} end`,
      mensaje_tardio_resumen: sql<string | null>`case when ${cases.para_responder_desde} is not null then ${cases.mensaje_tardio_resumen} end`,
      assigned_name: sql<string | null>`(select u.full_name from users u where u.id = ${cases.assigned_to})`,
      /*
       * Seis columnas que este listado devolvía y nadie leía.
       *
       * `email_message_id`, `email_thread_id`, `not_relevant_reason`,
       * `core_external_id`, `core_error_message` y `core_sent_at` salían en
       * cada fila de cada página. Los dos únicos consumidores del listado —la
       * bandeja y `/api/cases`— no tocan ninguna: se usan en el detalle de un
       * caso y en el worker, que las consultan por su cuenta.
       *
       * No era una fuga, y tampoco es sólo peso. `core_error_message` guarda
       * lo que devolvió el sistema del asegurador cuando falló un envío: texto
       * que escribió un tercero, en una respuesta que la pantalla no muestra y
       * nadie mira. Una columna que sale y no se usa es superficie regalada.
       *
       * Si alguna vuelve a hacer falta acá, se agrega — pero que sea porque
       * alguien la va a leer.
       */
      // Whether the claimant has actually been written back to, on whichever
      // channel they used. Computed from the outbound ledger instead of a
      // column on `cases` so it cannot drift from what was really sent, and
      // so it covers email and WhatsApp with one expression.
      // Only 'sent' counts — a queued or failed message is not a reply.
      replied_at: sql<string | null>`(
          select max(om.created_at)
            from outbound_messages om
           where om.case_id = ${cases.id}
             and om.tenant_id = ${cases.tenant_id}
             and om.status = 'sent'
        )`,
    })
    .from(cases)
    .where(buildCaseFilters(query, yo, ahora))
    .orderBy(...orden)
    // Pagination — max 100 per page (enforced in CaseQuerySchema)
    .limit(per_page)
    .offset((page - 1) * per_page);
}

/** El `count(*)` que viaja con el listado. Sin LIMIT: es el que crece. */
export function consultaConteo(datos: ClienteDatos, query: CaseQuery, yo?: string, ahora: Date = new Date()) {
  return datos
    .select({ n: sql<number>`count(*)::int` })
    .from(cases)
    .where(buildCaseFilters(query, yo, ahora));
}

/**
 * Los contadores por estado de la bandeja. Tampoco lleva LIMIT.
 *
 * `where` es opcional y a propósito angosto: sólo lo arma la búsqueda (`q`) y
 * el período (`desde`) de la bandeja, nunca los chips de estado/tipo/severidad
 * — esos contadores tienen que seguir sumando TODOS los estados, chip por
 * chip, o la pestaña que no está apretada mostraría siempre 0.
 */
export function consultaPorEstado(datos: ClienteDatos, where?: SQL) {
  return datos
    .select({ status: cases.status, n: sql<number>`count(*)::int` })
    .from(cases)
    .where(where)
    .groupBy(cases.status);
}

/**
 * Los contadores de las pestañas de la bandeja.
 *
 * Vive acá y no en la pantalla porque es la otra mitad de lo que cuesta abrir
 * la bandeja: la prueba de carga medía sólo `listCases` y llamaba a eso «el
 * listado», dejando afuera un agregado sin LIMIT — justamente lo que se degrada
 * cuando la tabla crece.
 */
export async function contarPorEstado(
  ctx: TenantContext,
  where?: SQL
): Promise<Array<{ status: string; n: number }>> {
  return enTenant<Array<{ status: string; n: number }>>(ctx, (db) =>
    consultaPorEstado(db, where)
  );
}

/**
 * Query cases with filtering, sorting, and pagination.
 *
 * **Ninguna consulta de acá filtra por inquilino.** No es un olvido: el filtro
 * lo pone la base. `enTenantVarias` manda las consultas en un lote junto a
 * `set_config('claimmix.tenant_id', …)`, y las políticas de RLS hacen el resto.
 *
 * Antes esta función recibía un `tenantId` suelto y armaba
 * `eq(cases.tenant_id, tenantId)` a mano, con un comentario pidiéndole al que
 * llamara que por favor no pasara un valor del cliente. Ese pedido era la única
 * defensa, y estaba repetido 198 veces en el repositorio. Ahora recibe un
 * `TenantContext`, que sólo se construye desde la sesión.
 *
 * De paso, el conteo y los datos viajan juntos: eran dos idas a la base y ahora
 * es una.
 *
 * raw_intake_text is intentionally NOT selected here (large field, not needed for list).
 */
export async function listCases(
  ctx: TenantContext,
  query: CaseQuery,
  yo?: string
): Promise<CaseListResult> {
  const { page, per_page } = query;
  // El mismo instante para el conteo y el listado: si no, un caso que cruza el
  // vencimiento entre las dos consultas se cuenta y no se lista (o al revés).
  const ahora = new Date();

  // ── Conteo y datos, en un solo viaje ───────────────────────────────────────
  let total: number;
  let data: Record<string, unknown>[];
  try {
    const [conteo, filas] = await enTenantVarias<
      [Array<{ n: number }>, Record<string, unknown>[]]
    >(ctx, (db) => [consultaConteo(db, query, yo, ahora), consultaListado(db, query, yo, ahora)]);
    total = conteo[0]?.n ?? 0;
    data = filas;
  } catch (err) {
    // Antes eran dos errores distintos, "count error" y "data error", porque
    // eran dos viajes. Ahora es uno solo y no hay forma de distinguirlos: decir
    // cuál de los dos falló sería inventarlo.
    throw new Error(`[listCases] query error: ${errorCode(err)}`);
  }

  const rows = data as unknown as CaseRow[];

  return {
    data: rows,
    meta: {
      total,
      page,
      per_page,
      pages: Math.ceil(total / per_page),
    },
  };
}

/**
 * Query cases for CSV export (up to 1000 rows, no pagination offset).
 * Accepts the same filters as listCases but ignores page/per_page.
 *
 * AC13: Same explicit tenant isolation as the list endpoint.
 */
export async function listCasesForExport(
  tenantId: string,
  query: Omit<CaseQuery, "page" | "per_page" | "sort" | "order">,
  yo?: string
): Promise<CaseRow[]> {
  // El mismo WHERE que el listado, que es lo que su contrato dice desde
  // siempre. El `eq(cases.tenant_id, …)` que estaba acá era el último que
  // quedaba escrito a mano en este archivo: lo pone la base.
  const where = buildCaseFilters(query, yo);

  try {
    // Max 1000 rows per export.
    // Sin `fecha_siniestro`: la alimenta el CSV de export.csv/route.ts, con su
    // propio CSV_HEADERS fijo, y ninguna columna ahí la pide — agregarla sería
    // ensanchar un consumidor que nadie pidió tocar.
    const data = await enTenant({ tenantId }, (db) =>
      db
        .select({
          id: cases.id,
          policy_number: cases.policy_number,
          policyholder_name: cases.policyholder_name,
          claim_type: cases.claim_type,
          status: cases.status,
          confidence_min: cases.confidence_min,
          assigned_to: cases.assigned_to,
          channel: cases.channel,
          created_at: cases.created_at,
        })
        .from(cases)
        .where(where)
        .orderBy(desc(cases.created_at))
        .limit(1000)
    );

    return data as unknown as CaseRow[];
  } catch (err) {
    throw new Error(`[listCasesForExport] error: ${errorCode(err)}`);
  }
}
