/**
 * GET /api/admin/provider-usage
 *
 * Returns provider usage stats for the tenant: call counts, failure rates,
 * rate-limit errors, invalid JSON counts, and average latency — all scoped to
 * the last 24 hours and the last 7 days. No PII returned.
 *
 * Also returns the current Gemini worker configuration (concurrency, delay).
 */

import { ok, err } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/require-admin";
import { db, tables } from "@/lib/db";
import { enTenant, type TenantContext, enTenantVarias } from "@/data/scope";
import { and, eq, gte, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

function getNumberEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export async function GET() {
  try {
    const { userRow } = await requireAdmin();
    const tenantId = userRow.tenant_id;
      // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
      // Este contexto es lo único que le dice de quién son los datos.
      const tenantCtx: TenantContext = { tenantId: tenantId };

    const t = tables.providerUsageEvents;

    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    /*
     * Las tres en un solo lote.
     *
     * Eran tres `await enTenant` seguidos, y cada uno abre su propio `batch()`
     * contra Neon con su `set_config` adelante: tres viajes de red para tres
     * agregados sobre la misma tabla que no dependen entre sí.
     *
     * `enTenantVarias` existe documentado para exactamente esto.
     */
    const [stats24h, recentErrors, stats7d] = await enTenantVarias<
      [
        Array<Record<string, unknown>>,
        Array<Record<string, unknown>>,
        Array<Record<string, unknown>>,
      ]
    >(tenantCtx, (db) => [
      // 24 horas, por proveedor y modelo.
          db
            .select({
              provider: t.provider,
              model: t.model,
              total: sql<number>`count(*)::int`,
              success: sql<number>`count(*) filter (where status = 'success')::int`,
              error: sql<number>`count(*) filter (where status = 'error')::int`,
              rate_limited: sql<number>`count(*) filter (where status = 'rate_limited')::int`,
              quota_exceeded: sql<number>`count(*) filter (where status = 'quota_exceeded')::int`,
              invalid_json: sql<number>`count(*) filter (where status = 'invalid_json')::int`,
              avg_latency_ms: sql<number>`round(avg(latency_ms) filter (where latency_ms is not null))::int`,
            })
            .from(t)
            .where(and( gte(t.created_at, since24h)))
            .groupBy(t.provider, t.model),
      // Los errores recientes, para poder mirarlos.
          db
            .select({
              provider: t.provider,
              model: t.model,
              status: t.status,
              error_code: t.error_code,
              error_message: t.error_message,
              retry_count: t.retry_count,
              latency_ms: t.latency_ms,
              created_at: t.created_at,
            })
            .from(t)
            .where(
              and(
                gte(t.created_at, since24h),
                sql`status != 'success'`
              )
            )
            .orderBy(sql`created_at desc`)
            .limit(20),
      // 7 días, sólo totales.
          db
            .select({
              provider: t.provider,
              total: sql<number>`count(*)::int`,
              failures: sql<number>`count(*) filter (where status != 'success')::int`,
              rate_limited: sql<number>`count(*) filter (where status = 'rate_limited')::int`,
            })
            .from(t)
            .where(and( gte(t.created_at, since7d)))
            .groupBy(t.provider)
    ]);

    // Current worker config from env
    const geminiConfig = {
      min_request_interval_ms: getNumberEnv("GEMINI_MIN_REQUEST_INTERVAL_MS", 1200),
      max_retries: getNumberEnv("GEMINI_MAX_RETRIES", 2),
      retry_base_ms: getNumberEnv("GEMINI_RETRY_BASE_MS", 1000),
      worker_concurrency: getNumberEnv("GEMINI_WORKER_CONCURRENCY", 1),
      worker_delay_ms: getNumberEnv("GEMINI_WORKER_DELAY_MS", 0),
    };

    return ok({
      stats_24h: stats24h,
      stats_7d: stats7d,
      recent_errors: recentErrors,
      gemini_config: geminiConfig,
    });
  } catch (e) {
    return err(e);
  }
}
