/**
 * Cases list query — `GET /api/cases`.
 *
 * Builds the Drizzle query for the cases listing endpoint.
 * Tenant isolation is enforced by an explicit tenant_id filter
 * (RLS is gone — the explicit filter is the ONLY tenant boundary):
 *   - IDOR: not applicable to list — users only see their tenant's rows
 *
 * AC9:  List is isolated by tenant_id.
 * AC11: Filter by claim type returns only matching cases.
 * AC12: Pagination per_page is capped at 100.
 */

import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { countRows, ilikeAny } from "@/lib/db/helpers";
import { enTenant, enTenantVarias, type TenantContext } from "@/data/scope";
import { cases } from "@/lib/db/schema";
import type { CaseRow } from "@/lib/db/types";
import type { CaseQuery, SortColumn } from "@/lib/schemas/cases";

export type { CaseRow };

export interface CaseListResult {
  data: CaseRow[];
  meta: {
    total: number;
    page: number;
    per_page: number;
    pages: number;
  };
}

/** Extract a loggable error code from a thrown DB error (PII-safe). */
function errCode(err: unknown): string {
  return (
    (err as { code?: string })?.code ??
    (err instanceof Error ? err.name : "UnknownError")
  );
}

/** Whitelisted sort columns (SortColumnSchema prevents arbitrary input). */
const SORT_COLUMNS = {
  created_at: cases.created_at,
  confidence_min: cases.confidence_min,
  status: cases.status,
} as const satisfies Record<SortColumn, unknown>;

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
function buildCaseFilters(
  query: Omit<CaseQuery, "page" | "per_page" | "sort" | "order">
): SQL | undefined {
  const { status, type, q, severity, customer_id, policy_id, channel, is_claim } =
    query;
  const conditions: (SQL | undefined)[] = [];

  if (status) conditions.push(eq(cases.status, status));
  if (type) conditions.push(eq(cases.claim_type, type));
  if (q) {
    // Case-insensitive substring search on policyholder_name and policy_number.
    // Parameterized via Drizzle — no raw SQL string interpolation.
    conditions.push(ilikeAny([cases.policyholder_name, cases.policy_number], q));
  }
  // AC18: Email-intake filters
  if (severity) conditions.push(eq(cases.severity, severity));
  if (customer_id) conditions.push(eq(cases.customer_id, customer_id));
  if (policy_id) conditions.push(eq(cases.policy_id, policy_id));
  if (channel) conditions.push(eq(cases.channel, channel));
  if (is_claim !== undefined) conditions.push(eq(cases.is_claim, is_claim));

  // `and()` sin condiciones devuelve undefined, que para drizzle es «sin WHERE».
  return conditions.length > 0 ? and(...conditions) : undefined;
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
  query: CaseQuery
): Promise<CaseListResult> {
  const {
    status,
    type,
    q,
    page,
    per_page,
    sort,
    order,
    // AC18: New email-intake filters
    severity,
    customer_id,
    policy_id,
    channel,
    is_claim,
  } = query;

  const where = buildCaseFilters(query);

  const sortColumn = SORT_COLUMNS[sort];
  const from = (page - 1) * per_page;

  // ── Conteo y datos, en un solo viaje ───────────────────────────────────────
  let total: number;
  let data: Record<string, unknown>[];
  try {
    const [conteo, filas] = await enTenantVarias<
      [Array<{ n: number }>, Record<string, unknown>[]]
    >(ctx, (db) => [
      db.select({ n: sql<number>`count(*)::int` }).from(cases).where(where),
      db
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
        .where(where)
        .orderBy(order === "asc" ? asc(sortColumn) : desc(sortColumn))
        // Pagination — max 100 per page (enforced in CaseQuerySchema)
        .limit(per_page)
        .offset(from),
    ]);
    total = conteo[0]?.n ?? 0;
    data = filas;
  } catch (err) {
    // Antes eran dos errores distintos, "count error" y "data error", porque
    // eran dos viajes. Ahora es uno solo y no hay forma de distinguirlos: decir
    // cuál de los dos falló sería inventarlo.
    throw new Error(`[listCases] query error: ${errCode(err)}`);
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
  query: Omit<CaseQuery, "page" | "per_page" | "sort" | "order">
): Promise<CaseRow[]> {
  // El mismo WHERE que el listado, que es lo que su contrato dice desde
  // siempre. El `eq(cases.tenant_id, …)` que estaba acá era el último que
  // quedaba escrito a mano en este archivo: lo pone la base.
  const where = buildCaseFilters(query);

  try {
    // Max 1000 rows per export.
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
    throw new Error(`[listCasesForExport] error: ${errCode(err)}`);
  }
}
