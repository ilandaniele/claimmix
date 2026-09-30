/**
 * GET /api/metricas/export.csv — el historial mes a mes del tablero, en CSV.
 *
 * Los últimos doce meses, uno por fila, con los mismos números que la vista
 * `?vista=historial` (los dos salen de `getHistorialDeMetricas`). Sin datos de
 * personas ni de casos: sólo conteos y medianas.
 *
 * Mismos roles que /api/metricas. El aislamiento por inquilino lo pone RLS, con
 * `enTenant`. Cupo propio, del mismo perfil que el resto de las exportaciones.
 */

import { NextResponse } from "next/server";
import { diaArgentino } from "@/core/fecha/dia-argentino";
import { COLUMNAS_DEL_HISTORIAL, porcentaje, unDecimal, type FilaDeHistorial } from "@/core/metricas/ciclo";
import { entrar } from "@/lib/api/entrada";
import { err } from "@/lib/api/respond";
import { ALL_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { buildCsv } from "@/lib/csv/safe-encode";
import { AppError } from "@/lib/errors";
import { getT } from "@/lib/i18n";
import { resolveAccountLocale } from "@/lib/i18n/locale";
import { logger } from "@/lib/observability/logger";
import { RATE_LIMIT_CONFIGS, type RateLimitResult } from "@/lib/rate-limit/index";
import { getHistorialDeMetricas } from "@/server/metrics/historial";

/** Una fila del CSV: números crudos, no el «3 h» de la pantalla, para que Excel los sume. */
function filaDeCsv(f: FilaDeHistorial): (string | number | null)[] {
  return [
    f.mes,
    f.reclamos,
    f.completados,
    porcentaje(f.sin_intervencion, f.reclamos),
    unDecimal(f.mediana_horas_listo),
    unDecimal(f.mediana_horas_cierre),
    unDecimal(f.mensajes_por_caso),
    f.escalados,
    f.cerrados,
  ];
}

export async function GET() {
  let ctx: RoleContext;
  let rl: RateLimitResult;
  try {
    ({ ctx, rl } = await entrar("metricas-export", RATE_LIMIT_CONFIGS.CASES_API, ...ALL_ROLES));
  } catch (e) {
    return err(e instanceof AppError ? e : new AppError("INTERNAL_ERROR"));
  }
  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes."));
  }

  const ahora = new Date();
  let filas: FilaDeHistorial[];
  try {
    filas = await getHistorialDeMetricas({ tenantId: ctx.userRow.tenant_id }, ahora);
  } catch (error) {
    logger.error(
      { error_name: error instanceof Error ? error.name : "UnknownError" },
      "get_api_metricas_export_csv.query_error"
    );
    return err(new AppError("INTERNAL_ERROR"));
  }

  const t = getT(await resolveAccountLocale(ctx.userRow.locale));
  const csv = buildCsv(COLUMNAS_DEL_HISTORIAL.map((c) => t(c)), filas.map(filaDeCsv));

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="metricas_${diaArgentino(ahora)}.csv"`,
      "Cache-Control": "no-store, no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
