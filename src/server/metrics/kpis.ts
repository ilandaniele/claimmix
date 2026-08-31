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
  ESTADOS_COMPLETADO_SIN_PERSONA,
  ESTADOS_ESCALADO,
} from "@/core/case/fsm";

import { enTenant, enTenantVarias, type TenantContext } from "@/data/scope";
import { aiUsage, authUsers, cases, users } from "@/lib/db/schema";
import { ClaimTypeSchema } from "@/lib/schemas/cases";

// ── Data fetching ─────────────────────────────────────────────────────────────

export interface MetricasSummary {
  total_cases_month: number;
  avg_opening_time_minutes: number | null;
  auto_completion_rate: number;
  escalated_count: number;
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
  period: { start: string; end: string };
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

/** Todo lo que muestra la pantalla, para un inquilino. */
export async function getTenantKpis(
  tenantCtx: TenantContext
): Promise<MetricasData> {
  // ── Date window ────────────────────────────────────────────────────────────
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

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
  ] = await Promise.all([
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
      enTenant(tenantCtx, (db) =>
        db
          .select({
            total: sql<number>`count(*)::int`,
            // Los DOS vocabularios: el canal real termina en `listo_para_core`,
            // no en `listo`. Ver `ESTADOS_COMPLETADO_SIN_PERSONA`.
            listo: sql<number>`count(*) filter (where ${inArray(cases.status, [
              ...ESTADOS_COMPLETADO_SIN_PERSONA,
            ])})::int`,
            cerrados: sql<number>`count(*) filter (where ${cases.status} = 'cerrado' and ${cases.closed_at} is not null)::int`,
            minutos: sql<number>`coalesce(sum(extract(epoch from (${cases.closed_at} - ${cases.created_at})) / 60) filter (where ${cases.status} = 'cerrado' and ${cases.closed_at} is not null), 0)::float8`,
          })
          .from(cases)
          .where(and(
            gte(cases.created_at, monthStart),
            lt(cases.created_at, monthEnd),
          ))
      ),
      // Agrupado en la base: traía las 458 filas de `cases` para contarlas.
      enTenant(tenantCtx, (db) =>
        db
          .select({ status: cases.status, n: sql<number>`count(*)::int` })
          .from(cases)
          .groupBy(cases.status)
      ),
      // Idem, y el `is not null` reemplaza al `if (row.claim_type)` que
      // descartaba esas filas después de haberlas traído.
      enTenant(tenantCtx, (db) =>
        db
          .select({ claim_type: cases.claim_type, n: sql<number>`count(*)::int` })
          .from(cases)
          .where(isNotNull(cases.claim_type))
          .groupBy(cases.claim_type)
      ),
      enTenant(tenantCtx, (db) =>
        db
          .select({ n: count() })
          .from(cases)
          .where(and(
            // Idem: el canal real escribe `requiere_especialista`.
            inArray(cases.status, [...ESTADOS_ESCALADO]),
            gte(cases.created_at, monthStart),
            lt(cases.created_at, monthEnd),
          ))
      ),
      /*
       * Los cinco de arriba, contados y ordenados por la base.
       *
       * El desempate por nombre es nuevo y deliberado: el `.sort()` de JS es
       * estable sobre el orden en que llegaron las filas, y un `order by`
       * sin criterio secundario no. Sin esto, dos analistas con la misma
       * cantidad podían intercambiarse entre dos cargas de la pantalla.
       */
      enTenant(tenantCtx, (db) =>
        db
          .select({
            assigned_to: cases.assigned_to,
            full_name: users.full_name,
            n: sql<number>`count(*)::int`,
          })
          .from(cases)
          .leftJoin(users, eq(cases.assigned_to, users.id))
          .where(and(
            eq(cases.status, "cerrado"),
            gte(cases.closed_at, monthStart),
            lt(cases.closed_at, monthEnd),
            isNotNull(cases.assigned_to),
          ))
          .groupBy(cases.assigned_to, users.full_name)
          .orderBy(sql`count(*) desc, ${users.full_name} asc`)
          .limit(5)
      ),
      enTenant(tenantCtx, (db) =>
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
          ))
      ),
      enTenant(tenantCtx, (db) =>
        db
          .select({
            calls: count(),
            prompt_tokens: sql<number>`coalesce(sum(${aiUsage.prompt_tokens}), 0)::float8`,
            completion_tokens: sql<number>`coalesce(sum(${aiUsage.completion_tokens}), 0)::float8`,
            cost_usd: sql<number>`coalesce(sum(${aiUsage.cost_usd}), 0)::float8`,
          })
          .from(aiUsage)
          
      ),
      enTenant(tenantCtx, (db) =>
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
          .groupBy(aiUsage.user_id, users.full_name, authUsers.email)
      ),
      enTenant(tenantCtx, (db) =>
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
          .groupBy(aiUsage.model)
      ),
    ]);

  const totalCasesMonth = resumenMes?.total ?? 0;

  // El mismo Math.round(total / n) de antes, con la suma hecha por la base.
  const avgOpeningMinutes: number | null =
    resumenMes && resumenMes.cerrados > 0
      ? Math.round(resumenMes.minutos / resumenMes.cerrados)
      : null;

  const listoCount = resumenMes?.listo ?? 0;
  const autoCompletionRate =
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
      avg_opening_time_minutes: avgOpeningMinutes,
      auto_completion_rate: autoCompletionRate,
      escalated_count: escalatedRow?.n ?? 0,
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
    period: { start: monthStart, end: monthEnd },
  };
}
