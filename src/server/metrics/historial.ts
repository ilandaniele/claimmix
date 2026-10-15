/**
 * El mes a mes de los últimos doce meses, en su propio viaje.
 *
 * Es la única métrica que recorre la auditoría de todo el año, y quien la pide
 * (la vista `?vista=historial` y el CSV) no dibuja nada del resto del tablero:
 * por eso no viaja dentro de `getTenantKpis`, que arrastraría cinco consultas
 * para descartarlas. Una sola consulta, un solo viaje.
 */

import "server-only";

import { completarHistorial, rangoDelHistorial, type FilaDeHistorial } from "@/core/metricas/ciclo";
import { enTenant, type TenantContext } from "@/data/scope";
import { consultaDeHistorial } from "@/server/metrics/trayecto";

/** `ahora` lo pone quien llama para que la ventana leída y la rellenada sean la misma. */
export async function getHistorialDeMetricas(
  tenantCtx: TenantContext,
  ahora = new Date()
): Promise<FilaDeHistorial[]> {
  const { desde, hasta } = rangoDelHistorial(ahora);
  const filas = await enTenant(tenantCtx, (db) => consultaDeHistorial(db, desde, hasta));
  return completarHistorial(ahora, filas);
}
