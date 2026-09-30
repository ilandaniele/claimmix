/**
 * Cambiar el estado a mano y lo que eso mueve para el equipo: vencimiento, plan
 * y pasos automáticos salen en el mismo lote que el UPDATE, y una persona nunca
 * dispara la asignación automática. Si lo del equipo falla, el estado se
 * aplica igual. Se mira el SQL contra una base suelta: no hay conexión.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClienteDatos } from "@/data/scope";
import * as schema from "@/lib/db/schema";

const espias = vi.hoisted(() => ({ enTenant: vi.fn(), enTenantVarias: vi.fn(), escribirAuditoria: vi.fn() }));

vi.mock("@/data/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/scope")>()),
  enTenant: espias.enTenant,
  enTenantVarias: espias.enTenantVarias,
}));
vi.mock("@/lib/db", () => ({ db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() }, tables: {} }));
vi.mock("@/lib/audit/log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit/log")>()),
  writeAuditLog: espias.escribirAuditoria,
}));

import { logger } from "@/lib/observability/logger";
import { patchCase, type PatchActor } from "@/server/cases/patch";

const dialecto = new PgDialect();
const sqlDe = (q: unknown) => dialecto.sqlToQuery((q as { getSQL(): never }).getSQL());
const dbSuelta = drizzle(neon("postgres://u:p@localhost/db"), { schema }) as unknown as ClienteDatos;

const CASO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ANA = "11111111-1111-4111-8111-111111111111";
const ADMIN: PatchActor = { id: "22222222-2222-4222-8222-222222222222", tenant_id: TENANT, role: "admin", plan: null };

function filaDelCaso(cambios: Record<string, unknown> = {}) {
  return {
    id: CASO,
    tenant_id: TENANT,
    status: "confirmacion_pendiente",
    claim_type: "choque",
    assigned_to: null,
    channel: "email",
    extraction_pending: false,
    extraction_lease_at: null,
    reglas_asignacion: { reglas: [{ tipos: ["choque"], personas: [ANA] }] },
    plazos_propios: null,
    plan_por_tipo: null,
    pesos_puntaje: null,
    ...cambios,
  };
}

/** Responde a cada consulta suelta según su verbo: la lectura del caso, o el UPDATE. */
function responder(caso: ReturnType<typeof filaDelCaso>, actualizada: Record<string, unknown> = {}) {
  espias.enTenant.mockImplementation(async (_ctx: unknown, armar: (db: ClienteDatos) => unknown) => {
    const { sql } = sqlDe(armar(dbSuelta));
    if (sql.startsWith("select")) return [caso];
    if (sql.startsWith('update "cases"')) return [{ ...caso, ...actualizada }];
    return [];
  });
  espias.enTenantVarias.mockResolvedValue([[{ ...caso, ...actualizada }]]);
}

/** Lo que recibió el lote, armado contra una base suelta. */
function lote(): { sql: string; params: unknown[] }[] {
  const armar = espias.enTenantVarias.mock.calls[0]![1] as (db: ClienteDatos) => unknown[];
  return armar(dbSuelta).map(sqlDe);
}

/** El SET del UPDATE, sin el `returning` que lista todas las columnas. */
const soloElSet = (sql: string) => sql.split(" where ")[0]!;

const lecturas = () =>
  espias.enTenant.mock.calls
    .map((c) => sqlDe((c[1] as (db: ClienteDatos) => unknown)(dbSuelta)))
    .filter((q) => q.sql.startsWith("select"));

beforeEach(() => {
  vi.clearAllMocks();
  espias.escribirAuditoria.mockResolvedValue(undefined);
});

describe("cambio de estado normal por una persona", () => {
  it("el UPDATE lleva el vencimiento y detrás va el plan, sin asignación automática aunque haya reglas", async () => {
    responder(filaDelCaso(), { status: "listo_para_core" });
    const r = await patchCase(CASO, { status: "listo_para_core" }, ADMIN, null, null);

    expect(r.case.status).toBe("listo_para_core");
    expect(espias.enTenantVarias).toHaveBeenCalledTimes(1);
    const [estado, plan, ...resto] = lote();
    expect(resto).toEqual([]);
    expect(estado!.sql).toMatch(/^update "cases" set /);
    expect(estado!.sql).toContain('"vence_en" = CASE WHEN');
    expect(estado!.sql).toContain("returning");
    expect(plan!.sql).toContain("INSERT INTO case_plan_pasos");
    expect(plan!.params).toContain(ADMIN.id);
  });

  it("un plazo propio anclado en el estado se aplica al vencimiento", async () => {
    responder(filaDelCaso({ plazos_propios: [{ clave: "sla_interno", titulo: "Interno", ancla: "listo_para_core", dias: 2 }] }), {
      status: "listo_para_core",
    });
    await patchCase(CASO, { status: "listo_para_core" }, ADMIN, null, null);

    expect(lote()[0]!.params).toContain("sla_interno");
  });

  it("la auditoría del cambio conserva de dónde a dónde y quién lo hizo", async () => {
    responder(filaDelCaso(), { status: "listo_para_core" });
    await patchCase(CASO, { status: "listo_para_core" }, ADMIN, "203.0.113.5", "Chrome");

    expect(espias.escribirAuditoria).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: ADMIN.id,
        event_type: "case.status_changed",
        payload: expect.objectContaining({ old_status: "confirmacion_pendiente", new_status: "listo_para_core" }),
      })
    );
  });

  it("lee la configuración del equipo junto con el caso, en una sola consulta", async () => {
    responder(filaDelCaso(), { status: "listo_para_core" });
    await patchCase(CASO, { status: "listo_para_core" }, ADMIN, null, null);

    const [lectura, ...otras] = lecturas();
    expect(otras).toEqual([]);
    expect(lectura!.sql).toContain('from "tenants"');
    expect(lectura!.sql).toContain('"reglas_asignacion"');
  });

  it("si el caso lo movió otra mano, cero filas: 409 y no reintenta con el UPDATE de siempre", async () => {
    responder(filaDelCaso());
    espias.enTenantVarias.mockResolvedValue([[]]);

    await expect(patchCase(CASO, { status: "listo_para_core" }, ADMIN, null, null)).rejects.toMatchObject({
      code: "FSM_INVALID_TRANSITION",
    });
    const escrituras = espias.enTenant.mock.calls.filter((c) =>
      sqlDe((c[1] as (db: ClienteDatos) => unknown)(dbSuelta)).sql.startsWith('update "cases"')
    );
    expect(escrituras).toEqual([]);
    expect(espias.escribirAuditoria).not.toHaveBeenCalled();
  });

  it("si lo del equipo falla, el estado se aplica igual sin tocar el vencimiento, y avisa", async () => {
    responder(filaDelCaso(), { status: "listo_para_core" });
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    espias.enTenantVarias.mockRejectedValue(Object.assign(new Error("column does not exist"), { code: "42703" }));

    const r = await patchCase(CASO, { status: "listo_para_core" }, ADMIN, null, null);

    expect(r.case.status).toBe("listo_para_core");
    expect(aviso).toHaveBeenCalledWith(
      { code: "42703", case_id: CASO, status: "listo_para_core" },
      "patch.efectos_fallaron"
    );
    const escritura = espias.enTenant.mock.calls
      .map((c) => sqlDe((c[1] as (db: ClienteDatos) => unknown)(dbSuelta)))
      .find((q) => q.sql.startsWith('update "cases"'));
    expect(soloElSet(escritura!.sql)).not.toContain("vence_en");
    expect(espias.escribirAuditoria).toHaveBeenCalledTimes(1);
  });
});

describe("cambio de estado a mano fuera del grafo", () => {
  it("en_liquidacion a pagado: estado, auditoría y pasos automáticos en un lote, y el vencimiento se limpia", async () => {
    responder(filaDelCaso({ status: "en_liquidacion" }), { status: "pagado" });
    await patchCase(CASO, { status: "pagado" }, ADMIN, null, null);

    expect(espias.enTenantVarias).toHaveBeenCalledTimes(1);
    const [estado, auditoria, tilda, ...resto] = lote();
    expect(resto).toEqual([]);
    expect(estado!.sql).not.toContain("CASE WHEN");
    expect(estado!.params).toEqual(expect.arrayContaining([null, null]));
    expect(auditoria!.sql).toContain('insert into "audit_log"');
    expect(tilda!.sql).toContain("UPDATE case_plan_pasos SET hecho_en = now()");
    expect(tilda!.params).toContain(ADMIN.id);
  });

  it("listo_para_core a en_liquidacion (entregado por fuera): arma el plan de la liquidación", async () => {
    responder(filaDelCaso({ status: "listo_para_core" }), { status: "en_liquidacion" });
    await patchCase(CASO, { status: "en_liquidacion" }, ADMIN, null, null);

    const sentencias = lote().map((s) => s.sql);
    expect(sentencias.some((s) => s.includes("INSERT INTO case_plan_pasos"))).toBe(true);
    expect(sentencias.join("\n")).not.toContain("SET assigned_to");
  });

  it("si lo del equipo falla, reintenta el estado con su auditoría, sin efectos, y avisa", async () => {
    responder(filaDelCaso({ status: "en_liquidacion" }), { status: "pagado" });
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    espias.enTenantVarias
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "42P01" }))
      .mockResolvedValueOnce([[filaDelCaso({ status: "pagado" })]]);

    const r = await patchCase(CASO, { status: "pagado" }, ADMIN, null, null);

    expect(r.case.status).toBe("pagado");
    expect(espias.enTenantVarias).toHaveBeenCalledTimes(2);
    expect(aviso).toHaveBeenCalledWith(
      { code: "42P01", case_id: CASO, status: "pagado" },
      "patch.efectos_fallaron"
    );
    const reintento = espias.enTenantVarias.mock.calls[1]![1] as (db: ClienteDatos) => unknown[];
    const sentencias = reintento(dbSuelta).map((q) => sqlDe(q).sql);
    expect(sentencias).toHaveLength(2);
    expect(soloElSet(sentencias[0]!)).not.toContain("vence_en");
  });
});

describe("cambios que no son de estado", () => {
  it("sólo reasignar no trae la configuración del equipo ni arma un lote", async () => {
    responder(filaDelCaso({ assigned_to: null }), { assigned_to: ANA });
    espias.enTenant.mockImplementation(async (_ctx: unknown, armar: (db: ClienteDatos) => unknown) => {
      const { sql } = sqlDe(armar(dbSuelta));
      if (sql.startsWith("select")) return [filaDelCaso()];
      return [{ ...filaDelCaso(), assigned_to: ANA }];
    });
    await patchCase(CASO, { assigned_to: ANA }, ADMIN, null, null);

    expect(espias.enTenantVarias).not.toHaveBeenCalled();
    const [lectura] = lecturas();
    expect(lectura!.sql).not.toContain('"reglas_asignacion"');
  });
});
