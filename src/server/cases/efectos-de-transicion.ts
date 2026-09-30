/**
 * Lo que rodea a un cambio de estado del caso, para el equipo (B9, B10, B11):
 * a quién le toca, cuándo vence y qué checklist arranca.
 *
 * Todo viaja en el mismo lote que el UPDATE de estado y lo decide la base: el
 * driver HTTP no deja leer, decidir y escribir, así que cada efecto es una
 * sentencia que se acota sola, con `status = hacia AND updated_at = now()`. Esa
 * segunda condición es «la fila la tocó esta transacción» —el trigger de
 * `cases` la iguala a `now()`—, la misma que usa `auditoriaSiQuedo`: si la
 * guarda del UPDATE de estado no pegó (otra mano movió el caso), ningún efecto
 * corre.
 *
 * Nada de esto sale al asegurado, a la respuesta ni al prompt: son criterios de
 * trabajo del equipo y viajan como argumento aparte.
 */

import "server-only";
import { and, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";

import { ReglasSchema, candidatasDeAsignacion, type Candidata, type Reglas } from "@/core/case/asignacion";
import { ESTADOS_CERRADOS } from "@/core/case/fsm";
import { PlanSchema, planPara, type Plan } from "@/core/case/plan-de-trabajo";
import { PlazosSchema, proximoVencimiento, type PlazoPropio } from "@/core/case/plazos";
import type { ClienteDatos } from "@/data/scope";
import { AuditEvent } from "@/lib/audit/log";
import { CASE_EDITOR_ROLES } from "@/lib/auth/roles";
import { cases, tenants, users } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import type { CaseStatus } from "@/lib/schemas/cases";

/** Lo que el equipo configuró y hace falta para decidir; el tipo es el del caso. */
export type CriteriosDeTrabajo = {
  tipo: string | null;
  reglas: Reglas | null;
  plazos: PlazoPropio[];
  plan: Plan | null;
};

/** Lo que traen `columnasDeTrabajo`, tal como sale de la base, sin validar. */
export type ConfiguracionGuardada = {
  reglas_asignacion: unknown;
  plazos_propios: unknown;
  plan_por_tipo: unknown;
};

/**
 * Lee una configuración guardada. NULL es «sin configurar»; una que no valida
 * también queda en null, con un aviso: un JSON roto de un inquilino no puede
 * frenar el estado de un caso.
 */
export function leerCriterio<S extends z.ZodTypeAny>(campo: string, schema: S, guardado: unknown): z.infer<S> | null {
  if (guardado === null || guardado === undefined) return null;
  const leido = schema.safeParse(guardado);
  if (leido.success) return leido.data;
  logger.warn({ campo }, "trabajo.criterio_invalido");
  return null;
}

/**
 * La configuración de trabajo del inquilino, como subselects de la fila del
 * caso: viaja en la misma consulta que el caso, sin una vuelta más a la base.
 * Sale sin validar; cada uso la valida, para que un JSON roto de un inquilino no
 * frene un estado.
 */
export const columnasDeTrabajo = {
  reglas_asignacion: sql<unknown>`(select ${tenants.reglas_asignacion} from ${tenants} where ${tenants.id} = ${cases.tenant_id})`,
  plazos_propios: sql<unknown>`(select ${tenants.plazos} from ${tenants} where ${tenants.id} = ${cases.tenant_id})`,
  plan_por_tipo: sql<unknown>`(select ${tenants.plan_por_tipo} from ${tenants} where ${tenants.id} = ${cases.tenant_id})`,
  pesos_puntaje: sql<unknown>`(select ${tenants.pesos_puntaje} from ${tenants} where ${tenants.id} = ${cases.tenant_id})`,
};

export function criteriosDeTrabajo(guardado: Partial<ConfiguracionGuardada>, tipo: string | null): CriteriosDeTrabajo {
  return {
    tipo,
    reglas: leerCriterio("reglas_asignacion", ReglasSchema, guardado.reglas_asignacion),
    plazos: leerCriterio("plazos", PlazosSchema, guardado.plazos_propios) ?? [],
    plan: leerCriterio("plan_por_tipo", PlanSchema, guardado.plan_por_tipo),
  };
}

/**
 * Las columnas de vencimiento que suma el UPDATE de estado al entrar a `hacia`.
 *
 * `cases.status` a la derecha de un SET es el estado de ANTES: repetir la misma
 * transición conserva el vencimiento que ya corría en vez de reiniciarlo. Volver
 * de `error_core` a `listo_para_core` (el reintento) tampoco es una entrega
 * nueva; pasar de `error_core` a `en_liquidacion` sí, y el art. 56 no sigue.
 *
 * Re-analizar un caso que ya corría su plazo lo deja pasar por `procesando` y
 * `listo` antes de volver a `hacia`, así que el estado previo no alcanza: si el
 * plazo que corre es el mismo que fijaría esta entrada, sigue corriendo. Las
 * claves son únicas, por eso la clave de `vence_plazo` identifica el plazo.
 */
export function ajusteDeVencimiento(
  hacia: CaseStatus,
  criterios: CriteriosDeTrabajo,
  ahora: Date = new Date()
): { vence_en?: SQL | null; vence_plazo?: SQL | null } {
  const v = proximoVencimiento({ hacia, tipo: criterios.tipo, ahora, plazos: criterios.plazos });
  if (v.accion === "mantener") return {};
  if (v.accion === "limpiar") return { vence_en: null, vence_plazo: null };
  const estadoPrevio = hacia === "listo_para_core" ? sql`IN (${hacia}, 'error_core')` : sql`= ${hacia}`;
  const sigueCorriendo = sql`${cases.vence_en} IS NOT NULL AND (${cases.status} ${estadoPrevio} OR ${cases.vence_plazo} = ${v.plazo}::text)`;
  return {
    vence_en: sql`CASE WHEN ${sigueCorriendo} THEN ${cases.vence_en} ELSE ${v.vence}::timestamptz END`,
    vence_plazo: sql`CASE WHEN ${sigueCorriendo} THEN ${cases.vence_plazo} ELSE ${v.plazo}::text END`,
  };
}

/** Una persona que edita casos y cuántos abiertos tiene: lo que devuelve `consultaDeCarga`. */
export interface PersonaConCarga {
  id: string;
  full_name: string;
  role: string;
  abiertos: number;
}

/**
 * Cuántos casos abiertos tiene cada persona que edita, de menos a más. Es la
 * carga con la que se reparte y la que muestra la pantalla de asignar.
 * `personas` acota a un pool.
 */
export function consultaDeCarga(db: ClienteDatos, personas?: readonly string[]) {
  return db
    .select({
      id: users.id,
      full_name: users.full_name,
      role: users.role,
      abiertos: sql<number>`count(${cases.id})::int`.as("abiertos"),
    })
    .from(users)
    .leftJoin(cases, and(eq(cases.assigned_to, users.id), notInArray(cases.status, [...ESTADOS_CERRADOS])))
    .where(and(inArray(users.role, CASE_EDITOR_ROLES), personas ? inArray(users.id, [...personas]) : undefined))
    .groupBy(users.id, users.full_name, users.role)
    .orderBy(sql`count(${cases.id})`, users.full_name, users.id);
}

const ESTADOS_QUE_AUTOASIGNAN: readonly CaseStatus[] = ["listo_para_core", "requiere_especialista"];
const ESTADOS_QUE_ARMAN_EL_PLAN: readonly CaseStatus[] = ["listo_para_core", "en_liquidacion"];
const ESTADOS_QUE_TILDAN: readonly CaseStatus[] = ["en_liquidacion", "pagado"];

/** El caso quedó en `hacia` por el UPDATE de esta misma transacción. */
const tocadoAhora = (caseId: string, hacia: CaseStatus) =>
  sql`c.id = ${caseId}::uuid AND c.status = ${hacia}::text AND c.updated_at = now()`;

const AUDITORIA = sql`INSERT INTO audit_log (tenant_id, actor_id, event_type, target_type, target_id, payload)`;

/**
 * Elige entre las candidatas a la de la regla más alta que tenga a alguien que
 * edite, y dentro de esa regla a la de menos carga. La regla que se audita es la
 * de la persona elegida, no la primera que coincidió.
 */
function autoasignar(db: ClienteDatos, caseId: string, hacia: CaseStatus, candidatas: Candidata[]) {
  const pool = consultaDeCarga(
    db,
    candidatas.map((c) => c.persona)
  );
  return db.execute(sql`
    WITH carga AS (
      SELECT k.id, c.regla FROM (${pool.getSQL()}) k
      JOIN jsonb_to_recordset(${JSON.stringify(candidatas)}::jsonb) AS c(persona uuid, regla int) ON c.persona = k.id
      ORDER BY c.regla, k.abiertos, k.full_name, k.id LIMIT 1
    ),
    asignado AS (
      UPDATE cases c SET assigned_to = (SELECT id FROM carga)
      WHERE ${tocadoAhora(caseId, hacia)} AND c.assigned_to IS NULL AND EXISTS (SELECT 1 FROM carga)
      RETURNING c.id, c.tenant_id, c.assigned_to, (SELECT regla FROM carga) AS regla
    )
    ${AUDITORIA}
    SELECT tenant_id, NULL::uuid, ${AuditEvent.CASE_ASSIGNED}::text, 'case', id::text,
           jsonb_build_object('auto', true, 'regla', regla, 'assigned_to', assigned_to, 'assigned_from', NULL::uuid)
    FROM asignado
  `);
}

/** Un caso que ya tiene plan no recibe otro: los pasos de una plantilla que cambió no se cuelan en uno empezado. */
function crearPlan(
  db: ClienteDatos,
  caseId: string,
  hacia: CaseStatus,
  actorId: string | null,
  criterios: CriteriosDeTrabajo,
  origen: string
) {
  const pasos = planPara(criterios.tipo, criterios.plan).map((p, orden) => ({
    clave: p.clave,
    titulo: p.titulo,
    orden,
    auto: p.auto ?? null,
  }));
  return db.execute(sql`
    WITH nuevos AS (
      INSERT INTO case_plan_pasos (case_id, tenant_id, clave, titulo, orden, auto)
      SELECT c.id, c.tenant_id, p.clave, p.titulo, p.orden, p.auto
      FROM cases c, jsonb_to_recordset(${JSON.stringify(pasos)}::jsonb) AS p(clave text, titulo text, orden smallint, auto text)
      WHERE ${tocadoAhora(caseId, hacia)} AND NOT EXISTS (SELECT 1 FROM case_plan_pasos x WHERE x.case_id = c.id)
      ON CONFLICT (case_id, clave) DO NOTHING
      RETURNING case_id, tenant_id
    )
    ${AUDITORIA}
    SELECT tenant_id, ${actorId}::uuid, ${AuditEvent.CASE_PLAN_CREATED}::text, 'case', case_id::text,
           jsonb_build_object('pasos', count(*)::int, 'origen', ${origen}::text)
    FROM nuevos GROUP BY tenant_id, case_id
  `);
}

function tildarAutomaticos(db: ClienteDatos, caseId: string, hacia: CaseStatus, actorId: string | null) {
  return db.execute(sql`
    WITH hechos AS (
      UPDATE case_plan_pasos SET hecho_en = now(), hecho_por = ${actorId}::uuid, origen = 'auto'
      WHERE case_id = ${caseId}::uuid AND auto = ${hacia}::text AND hecho_en IS NULL
        AND EXISTS (SELECT 1 FROM cases c WHERE ${tocadoAhora(caseId, hacia)})
      RETURNING case_id, tenant_id, clave
    )
    ${AUDITORIA}
    SELECT tenant_id, ${actorId}::uuid, ${AuditEvent.CASE_PLAN_STEP}::text, 'case', case_id::text,
           jsonb_build_object('clave', clave, 'hecho', true, 'auto', true)
    FROM hechos
  `);
}

/**
 * Las sentencias que van detrás del UPDATE de estado, en su mismo lote.
 *
 * Sólo el agente autoasigna: cuando una persona cambia el estado, la
 * asignación es cosa suya. El plan y los pasos automáticos corren en los dos
 * casos.
 */
export function efectosDeTransicion(
  db: ClienteDatos,
  e: {
    caseId: string;
    hacia: CaseStatus;
    origen: "agente" | "persona";
    actorId: string | null;
    criterios: CriteriosDeTrabajo;
    ahora?: Date;
  }
) {
  const efectos: unknown[] = [];
  const candidatas =
    e.origen === "agente" && ESTADOS_QUE_AUTOASIGNAN.includes(e.hacia)
      ? candidatasDeAsignacion(e.criterios.reglas, { tipo: e.criterios.tipo, ahora: e.ahora ?? new Date() })
      : [];
  if (candidatas.length) efectos.push(autoasignar(db, e.caseId, e.hacia, candidatas));
  if (ESTADOS_QUE_ARMAN_EL_PLAN.includes(e.hacia)) {
    efectos.push(crearPlan(db, e.caseId, e.hacia, e.actorId, e.criterios, e.origen));
  }
  if (ESTADOS_QUE_TILDAN.includes(e.hacia)) efectos.push(tildarAutomaticos(db, e.caseId, e.hacia, e.actorId));
  return efectos;
}
