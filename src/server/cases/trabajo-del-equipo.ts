/**
 * Cómo trabaja el equipo de una aseguradora (B9, B10, B11, B13): las reglas de
 * asignación, los plazos propios, el plan por tipo y los pesos del puntaje,
 * más la carga de cada persona. Es lo que edita un admin desde /agente.
 *
 * Todo es para el equipo: nada de esto sale al asegurado.
 */

import "server-only";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { ReglasSchema } from "@/core/case/asignacion";
import { PlazosSchema, PLAZOS_LEGALES } from "@/core/case/plazos";
import { PlanSchema, PLAN_POR_DEFECTO } from "@/core/case/plan-de-trabajo";
import { PesosSchema, PESOS_POR_DEFECTO } from "@/core/case/puntaje-complejidad";
import { enTenant, enTenantVarias, type TenantContext } from "@/data/scope";
import { AuditEvent } from "@/lib/audit/log";
import { conteoDe } from "@/lib/db/filas";
import { tenants } from "@/lib/db/schema";
import { faltaLa0042 } from "@/server/core-sync/config";
import { consultaDeCarga, type PersonaConCarga } from "@/server/cases/efectos-de-transicion";

/**
 * Qué se puede guardar. El nombre del campo es el de la columna de `tenants`, y
 * la unión discriminada es la lista blanca: `campo` sólo puede ser uno de estos
 * cuatro literales, así que es seguro usarlo como identificador de la sentencia.
 * `null` vuelve a los valores por defecto del código.
 */
export const CambioDeTrabajoSchema = z.discriminatedUnion("campo", [
  z.object({ campo: z.literal("reglas_asignacion"), valor: ReglasSchema.nullable() }).strict(),
  z.object({ campo: z.literal("plazos"), valor: PlazosSchema.nullable() }).strict(),
  z.object({ campo: z.literal("plan_por_tipo"), valor: PlanSchema.nullable() }).strict(),
  z.object({ campo: z.literal("pesos_puntaje"), valor: PesosSchema.nullable() }).strict(),
]);
export type CambioDeTrabajo = z.infer<typeof CambioDeTrabajoSchema>;
export type CampoDeTrabajo = CambioDeTrabajo["campo"];

/** Lo que se ve cuando el equipo no configuró nada. Las reglas y los plazos, sin nada, son vacíos. */
export const TRABAJO_POR_DEFECTO = {
  reglas_asignacion: { reglas: [] },
  plazos: [],
  plan_por_tipo: PLAN_POR_DEFECTO,
  pesos_puntaje: PESOS_POR_DEFECTO,
} as const;

export interface TrabajoDelEquipo {
  /** Tal como está guardado, sin validar; null es «sin configurar». */
  guardado: {
    reglas_asignacion: unknown;
    plazos: unknown;
    plan_por_tipo: unknown;
    pesos_puntaje: unknown;
  };
  porDefecto: typeof TRABAJO_POR_DEFECTO;
  legales: typeof PLAZOS_LEGALES;
  carga: PersonaConCarga[];
}

type FilaGuardada = TrabajoDelEquipo["guardado"];

/** Una sola ida a la base: las cuatro columnas del inquilino y la carga del equipo. */
export async function leerTrabajo(ctx: TenantContext): Promise<TrabajoDelEquipo> {
  const [filas, carga] = await enTenantVarias<[FilaGuardada[], PersonaConCarga[]]>(ctx, (db) => [
    db
      .select({
        reglas_asignacion: tenants.reglas_asignacion,
        plazos: tenants.plazos,
        plan_por_tipo: tenants.plan_por_tipo,
        pesos_puntaje: tenants.pesos_puntaje,
      })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId))
      .limit(1),
    consultaDeCarga(db),
  ]).catch(faltaLa0042);

  return {
    guardado: filas[0] ?? { reglas_asignacion: null, plazos: null, plan_por_tipo: null, pesos_puntaje: null },
    porDefecto: TRABAJO_POR_DEFECTO,
    legales: PLAZOS_LEGALES,
    carga,
  };
}

/**
 * Guarda una de las cuatro configuraciones y deja asentado quién la cambió, con
 * el valor de antes y el de después. Es una sola sentencia: el driver HTTP no
 * deja leer el valor viejo para auditarlo y escribir el nuevo por separado, y
 * con un CTE la auditoría no puede quedar sin el cambio ni el cambio sin ella.
 * Devuelve false si no había fila del inquilino que cambiar.
 *
 * No recalcula ni reasigna nada: lo nuevo rige desde el próximo evento de cada
 * caso.
 */
export async function guardarTrabajo(ctx: TenantContext, actorId: string, cambio: CambioDeTrabajo): Promise<boolean> {
  const columna = sql.identifier(cambio.campo);
  // NULL de SQL para «volver al valor por defecto»: JSON.stringify(null) sería un jsonb `null`.
  const valor = cambio.valor === null ? null : JSON.stringify(cambio.valor);
  const resultado = await enTenant(ctx, (db) =>
    db.execute(sql`
      WITH viejo AS (
        SELECT ${columna} AS valor FROM tenants WHERE id = ${ctx.tenantId}::uuid
      ),
      nuevo AS (
        UPDATE tenants SET ${columna} = ${valor}::jsonb WHERE id = ${ctx.tenantId}::uuid RETURNING id
      ),
      auditoria AS (
        INSERT INTO audit_log (tenant_id, actor_id, event_type, target_type, target_id, payload)
        SELECT nuevo.id, ${actorId}::uuid, ${AuditEvent.TENANT_WORK_SETTINGS_UPDATED}::text, 'tenant', nuevo.id::text,
               jsonb_build_object('campo', ${cambio.campo}::text, 'antes', viejo.valor, 'despues', ${valor}::jsonb)
        FROM nuevo CROSS JOIN viejo
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM nuevo
    `)
  ).catch(faltaLa0042);
  return conteoDe(resultado) > 0;
}
