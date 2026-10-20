/**
 * La cartera de clientes, en una consulta.
 *
 * Es lo que necesita ver quien opera el producto: quiénes son, qué plan
 * tienen, cuántas denuncias les entraron este mes, cuánto se les factura y
 * cuánto costó atenderlos. Hasta ahora eso vivía repartido entre un script y un
 * endpoint que sólo contesta por el tenant de quien pregunta, así que para
 * mirar tres clientes había que consultarlos de a uno.
 *
 * Cruza tenants a propósito, y por eso la pantalla que la usa está detrás de
 * requireOperator y no de requireAdmin: el admin de un asegurador no puede ver
 * quiénes son los otros ni cuánto pagan.
 *
 * El tenant de la demo pública se excluye. No es un cliente: no tiene contrato,
 * su gasto lo paga la casa, y sumarlo a la cartera hace que el número de
 * clientes y el de margen mientan los dos a la vez.
 */

import "server-only";
import { and, eq, gte, lt, ne, sql } from "drizzle-orm";
import { db, tables, type DbDueno } from "@/lib/db";
import { computeInvoice, computeMargin, PLAN_CATALOG, isPlan } from "@/lib/billing/plans";
import { resolveBillingPeriod, periodoAntesDelAlta } from "@/lib/billing/period";
import { getDemoTenantId } from "@/server/ai/budget";
import { paraCadaBase } from "@/server/bases/cada-base";
import { esCasoReal } from "@/server/core-sync/lectura";

/** Cuánto se tarda como máximo en pasar por las bases de los clientes. */
const MS_PARA_RECORRER = 30_000;

/**
 * La consulta en cada base de cliente, con las filas juntas.
 *
 * Con `BASE_POR_CLIENTE=1` los casos y las facturas congeladas viven en la base de
 * cada inquilino. Una base que no se pudo leer, o que no entró en el tiempo, no se
 * saltea: la cartera mostraría el total de otros clientes como si fuera el de todos,
 * y eso no se corrige solo. Sin la bandera es una sola consulta, como siempre.
 */
async function enCadaBase<T>(consulta: (db: DbDueno) => PromiseLike<T[]>): Promise<T[]> {
  const { resultados, pendientes, fallas } = await paraCadaBase(async (base) => consulta(base), {
    hasta: Date.now() + MS_PARA_RECORRER,
  });
  if (pendientes + fallas > 0) {
    throw new Error(`[cartera] no se pudo leer ${pendientes + fallas} base(s) de cliente: los números quedarían incompletos.`);
  }
  return resultados.flat();
}

const ESTADOS_DE_BASE = ["creando", "lista", "fallida", "borrada"] as const;
export type EstadoDeBase = (typeof ESTADOS_DE_BASE)[number];

const estadoDeBase = (v: unknown): EstadoDeBase | null =>
  ESTADOS_DE_BASE.find((e) => e === v) ?? null;

export interface TenantSummary {
  id: string;
  name: string;
  plan: string;
  plan_label: string;
  billing_status: string;
  contact_email: string | null;
  trial_ends_at: string | null;
  created_at: string;
  monthly_fee_usd: number;
  included_claims: number;
  overage_price_usd: number;
  /** Denuncias del mes que el agente reconoció como tales. */
  billable_claims: number;
  total_cases: number;
  invoice_total_usd: number;
  ai_cost_usd: number;
  margin_pct: number | null;
  /** Nació por el alta automática: su prueba tiene tope de IA propio. */
  autoalta: boolean;
  base_estado: EstadoDeBase | null;
  /** Peso de su base propia; null sin base o sin permiso para medirla. */
  base_mb: number | null;
  /** IA del mes por denuncia facturable; null sin denuncias. */
  costo_medio_usd: number | null;
}

/**
 * Todos los clientes con sus números del mes en curso.
 *
 * Una sola pasada por `cases` y otra por `ai_usage`, agrupadas por tenant, en
 * vez de dos consultas por cliente. Con tres clientes da igual; con treinta es
 * la diferencia entre una pantalla y una espera.
 */
export async function listTenantSummaries(month?: string | null): Promise<{
  month: string;
  tenants: TenantSummary[];
}> {
  const range = resolveBillingPeriod(month ?? null)!;
  const demoTenantId = getDemoTenantId();

  // sin-inquilino: Reporte de facturación: mira a todos los inquilinos de una, que es
  // exactamente lo que un dueño necesita ver y lo que RLS impediría.
  const tenantRows = await db
    .select({
      id: tables.tenants.id,
      name: tables.tenants.name,
      plan: tables.tenants.plan,
      billing_status: tables.tenants.billing_status,
      monthly_fee_usd: tables.tenants.monthly_fee_usd,
      included_claims: tables.tenants.included_claims,
      overage_price_usd: tables.tenants.overage_price_usd,
      contact_email: tables.tenants.contact_email,
      trial_ends_at: tables.tenants.trial_ends_at,
      created_at: tables.tenants.created_at,
      // `to_jsonb` y no la columna: antes de la 0048 `tenants.autoalta` tira 42703.
      autoalta: sql<boolean | null>`coalesce((to_jsonb(${tables.tenants}.*) ->> 'autoalta')::boolean, false)`,
      base_estado: sql<string | null>`(select b.estado from public.tenant_bases b where b.tenant_id = ${tables.tenants.id})`,
      // El nombre es el de `nombreDeBase`. Sin CONNECT sobre la base, `pg_database_size` tiraría.
      base_mb: sql<number | null>`(select round(pg_database_size(d.oid) / 1048576.0)::int from pg_database d where d.datname = 't_' || replace(${tables.tenants.id}::text, '-', '') and has_database_privilege(d.oid, 'CONNECT'))`,
    })
    .from(tables.tenants)
    .where(demoTenantId ? ne(tables.tenants.id, demoTenantId) : undefined)
    .orderBy(tables.tenants.created_at);

  // sin-inquilino: Idem: agrega casos de todos los inquilinos en una sola pasada.
  const caseRows = await enCadaBase((db) =>
    db
      .select({
        tenant_id: tables.cases.tenant_id,
        total: sql<number>`count(*)::int`,
        billable: sql<number>`count(*) filter (where is_claim is true)::int`,
      })
      .from(tables.cases)
      .where(
        and(
          gte(tables.cases.created_at, range.start),
          lt(tables.cases.created_at, range.next),
          esCasoReal
        )
      )
      .groupBy(tables.cases.tenant_id)
  );

  // sin-inquilino: Idem: el consumo de IA de todos, para la misma pantalla.
  const usageRows = await db
    .select({
      tenant_id: tables.aiUsage.tenant_id,
      cost_usd: sql<number>`coalesce(sum(${tables.aiUsage.cost_usd}), 0)::float8`,
    })
    .from(tables.aiUsage)
    .where(
      and(
        gte(tables.aiUsage.created_at, range.start),
        lt(tables.aiUsage.created_at, range.next)
      )
    )
    .groupBy(tables.aiUsage.tenant_id);

  const casesByTenant = new Map(caseRows.map((r) => [r.tenant_id, r]));
  const costByTenant = new Map(usageRows.map((r) => [r.tenant_id, Number(r.cost_usd)]));

  /*
   * Las facturas ya emitidas de ese mes, que MANDAN sobre el recálculo.
   *
   * Esta pantalla recalculaba siempre desde `cases` en vivo. Para un mes ya
   * cerrado eso contradice la factura que la aseguradora tiene en la mano: se
   * congela el 1° del mes siguiente con `getStatement`, y desde entonces basta
   * que alguien corrija un caso —marcarlo como no-denuncia, cerrarlo mal,
   * borrarlo— para que la cartera muestre otro número.
   *
   * Y no avisa cuál es cuál: son dos pantallas del mismo producto diciendo dos
   * totales distintos del mismo mes, las dos con cara de ser la respuesta.
   *
   * La regla ya estaba decidida y escrita en `statement.ts`: una factura por mes
   * y, una vez congelada, se lee y no se recalcula. Acá se respeta.
   *
   * sin-inquilino: mismo reporte de dueño que las consultas de arriba.
   */
  const congeladas = await enCadaBase((db) =>
    db
      .select({
        tenant_id: tables.billingInvoices.tenant_id,
        total_usd: tables.billingInvoices.total_usd,
        billable_claims: tables.billingInvoices.billable_claims,
      })
      .from(tables.billingInvoices)
      .where(eq(tables.billingInvoices.month, range.month))
  );

  const facturaPorInquilino = new Map(congeladas.map((f) => [f.tenant_id, f]));

  const tenants = tenantRows
    .filter((t) => !periodoAntesDelAlta(range, t.created_at))
    .map((t): TenantSummary => {
      const counts = casesByTenant.get(t.id);
      const cost = costByTenant.get(t.id) ?? 0;
      const facturada = facturaPorInquilino.get(t.id);
      const fallback = isPlan(t.plan) ? PLAN_CATALOG[t.plan] : PLAN_CATALOG.piloto;

      // Los términos guardados del tenant mandan sobre el catálogo: un contrato
      // firmado no cambia porque alguien haya editado la lista de precios.
      const billable = facturada ? Number(facturada.billable_claims) : counts?.billable ?? 0;
      const aiCost = Math.round(cost * 10000) / 10000;
      const baseMb = t.base_mb == null ? null : Number(t.base_mb);
      const invoice = computeInvoice({
        claims: counts?.billable ?? 0,
        monthly_fee_usd: Number(t.monthly_fee_usd ?? fallback.monthly_fee_usd),
        included_claims: Number(t.included_claims ?? fallback.included_claims),
        overage_price_usd: Number(t.overage_price_usd ?? fallback.overage_price_usd),
        label: fallback.label,
      });

      return {
        id: t.id,
        name: t.name,
        plan: t.plan,
        plan_label: fallback.label,
        billing_status: t.billing_status,
        contact_email: t.contact_email,
        trial_ends_at: t.trial_ends_at,
        created_at: t.created_at,
        monthly_fee_usd: invoice.monthly_fee_usd,
        included_claims: invoice.included_claims,
        overage_price_usd: invoice.overage_price_usd,
        // Si el mes ya se facturó, lo que vale es lo que dice la factura.
        billable_claims: billable,
        total_cases: counts?.total ?? 0,
        invoice_total_usd: facturada
          ? Number(facturada.total_usd)
          : invoice.total_usd,
        ai_cost_usd: aiCost,
        // El margen, contra el total que de verdad se cobró.
        margin_pct: computeMargin(
          facturada ? Number(facturada.total_usd) : invoice.total_usd,
          cost
        ).margin_pct,
        autoalta: t.autoalta === true,
        base_estado: estadoDeBase(t.base_estado),
        base_mb: baseMb !== null && Number.isFinite(baseMb) && baseMb >= 0 ? baseMb : null,
        costo_medio_usd: billable > 0 ? Math.round((aiCost / billable) * 10_000) / 10_000 : null,
      };
    });

  return { month: range.month, tenants };
}
