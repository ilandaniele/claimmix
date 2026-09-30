/**
 * Confirmar un campo y lo que eso mueve para el equipo: si el caso cambia de
 * estado, el vencimiento, la asignación y el plan salen en el mismo lote; si el
 * campo es de los que pesan en el puntaje, se recalcula. Nada de eso cambia lo
 * que ya hacía la confirmación, y si lo del equipo falla el estado se aplica
 * igual.
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
vi.mock("@/server/cases/gap-analyzer", () => ({ analyzeEmailClaimGaps: vi.fn() }));
vi.mock("@/server/cases/inbound-messages", () => ({ mensajesEntrantes: vi.fn().mockResolvedValue([]) }));
vi.mock("@/server/memory/update", () => ({ updateMemoryFromConfirmation: vi.fn() }));

import { logger } from "@/lib/observability/logger";
import { resolveFieldConfirmation } from "@/server/cases/confirm-field";
import { analyzeEmailClaimGaps } from "@/server/cases/gap-analyzer";

const dialecto = new PgDialect();
const sqlDe = (q: unknown) => dialecto.sqlToQuery((q as { getSQL(): never }).getSQL());
// Arma las consultas sin conectarse: nadie las espera.
const dbSuelta = drizzle(neon("postgres://u:p@localhost/db"), { schema }) as unknown as ClienteDatos;

const CASO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ANA = "11111111-1111-4111-8111-111111111111";
const DUENO = { id: "22222222-2222-4222-8222-222222222222", role: "owner" as const };

const PESOS = {
  severidad: 10,
  fraude: 0,
  lesiones: 0,
  monto: { peso: 0, umbral: { bajo: 1, alto: 2 } },
  campos: [{ clave: "tiene_gnc", valor: "si", puntos: 90 }],
};

function filaDelCaso(cambios: Record<string, unknown> = {}) {
  return {
    id: CASO,
    status: "confirmacion_pendiente",
    assigned_to: null,
    claim_type: "choque",
    severity: "medium",
    fraud_risk_level: null,
    injury_severity: null,
    monto_estimado: null,
    reglas_asignacion: { reglas: [{ tipos: ["choque"], personas: [ANA] }] },
    plazos_propios: null,
    plan_por_tipo: null,
    pesos_puntaje: null,
    ...cambios,
  };
}

/** Responde a cada consulta de la confirmación según de qué tabla es. */
function responderConsultas(caso: ReturnType<typeof filaDelCaso>, campos: { field_key: string; field_value: string }[] = []) {
  espias.enTenant.mockImplementation(async (_ctx: unknown, armar: (db: ClienteDatos) => unknown) => {
    const { sql } = sqlDe(armar(dbSuelta));
    if (sql.startsWith('select "id", "status", "assigned_to"')) return [caso];
    if (sql.startsWith("select") && sql.includes('from "extracted_fields"')) {
      return campos.map((c) => ({ ...c, confidence: "1.00" }));
    }
    if (sql.startsWith('update "cases"') && sql.includes("returning")) return [{ id: CASO }];
    return [];
  });
}

/** Lo que recibió el lote, armado contra una base suelta. */
function lote(): { sql: string; params: unknown[] }[] {
  const armar = espias.enTenantVarias.mock.calls[0]![1] as (db: ClienteDatos) => unknown[];
  return armar(dbSuelta).map(sqlDe);
}

const confirmar = (campo: string, valor = "si", actor = DUENO) =>
  resolveFieldConfirmation({ tenantId: TENANT }, CASO, { field_key: campo, value: valor, action: "confirm" }, actor);

beforeEach(() => {
  vi.clearAllMocks();
  espias.enTenantVarias.mockResolvedValue([[{ id: CASO }]]);
  espias.escribirAuditoria.mockResolvedValue(undefined);
  vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({ status: "listo_para_core" } as never);
});

describe("confirmar un campo que completa el caso", () => {
  it("estado, auditoría, vencimiento, asignación y plan van en un solo lote", async () => {
    responderConsultas(filaDelCaso());
    const r = await confirmar("full_name", "Juan Pérez");

    expect(r.new_status).toBe("listo_para_core");
    expect(espias.enTenantVarias).toHaveBeenCalledTimes(1);
    const [estado, auditoria, asigna, plan, ...resto] = lote();
    expect(resto).toEqual([]);
    expect(estado!.sql).toMatch(/^update "cases" set "status" = \$\d+/);
    expect(estado!.sql).toContain('"vence_en" = CASE WHEN');
    expect(estado!.sql).toContain('"status" = $');
    expect(estado!.sql).toContain("returning");
    expect(auditoria!.sql).toContain('insert into "audit_log"');
    expect(asigna!.sql).toContain("UPDATE cases c SET assigned_to");
    expect(plan!.sql).toContain("INSERT INTO case_plan_pasos");
  });

  it("la auditoría del estado guarda de dónde a dónde y quién confirmó, y queda sólo si el estado pegó", async () => {
    responderConsultas(filaDelCaso());
    await confirmar("full_name", "Juan Pérez");

    const [, auditoria] = lote();
    expect(auditoria!.sql).toContain('"cases"."updated_at" = now()');
    expect(auditoria!.params).toContain(DUENO.id);
    const payload = auditoria!.params.find((p) => typeof p === "string" && p.includes("old_status"));
    expect(JSON.parse(payload as string)).toEqual({
      from: "confirmacion_pendiente",
      to: "listo_para_core",
      old_status: "confirmacion_pendiente",
      new_status: "listo_para_core",
      trigger: "field_confirmation",
    });
    expect(espias.escribirAuditoria).not.toHaveBeenCalledWith(expect.objectContaining({ event_type: "case.status_changed" }));
  });

  it("los efectos los pide el agente: sin actor y con la asignación automática", async () => {
    responderConsultas(filaDelCaso());
    await confirmar("full_name", "Juan Pérez");

    const [, , asigna] = lote();
    expect(asigna!.sql).toContain("NULL::uuid");
    expect(asigna!.sql).toContain("'auto', true");
  });

  it("sin reglas del inquilino no hay asignación, pero el plan y el vencimiento siguen", async () => {
    responderConsultas(filaDelCaso({ reglas_asignacion: null }));
    await confirmar("full_name", "Juan Pérez");

    const sentencias = lote();
    expect(sentencias.map((s) => s.sql).join("\n")).not.toContain("SET assigned_to");
    expect(sentencias.some((s) => s.sql.includes("INSERT INTO case_plan_pasos"))).toBe(true);
  });

  it("si el caso ya lo movió otra mano no se aplica ni se cae al UPDATE de siempre", async () => {
    responderConsultas(filaDelCaso());
    espias.enTenantVarias.mockResolvedValue([[]]);

    const r = await confirmar("full_name", "Juan Pérez");

    expect(r.new_status).toBe("confirmacion_pendiente");
    expect(espias.escribirAuditoria).not.toHaveBeenCalledWith(expect.objectContaining({ event_type: "case.status_changed" }));
  });

  it("si lo del equipo falla, el estado se aplica igual, con su auditoría de siempre y el aviso", async () => {
    responderConsultas(filaDelCaso());
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    espias.enTenantVarias.mockRejectedValue(Object.assign(new Error("column does not exist"), { code: "42703" }));

    const r = await confirmar("full_name", "Juan Pérez");

    expect(r.new_status).toBe("listo_para_core");
    expect(aviso).toHaveBeenCalledWith(expect.objectContaining({ case_id: CASO }), "confirm_field.efectos_fallaron");
    expect(espias.escribirAuditoria).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "case.status_changed",
        payload: { from: "confirmacion_pendiente", to: "listo_para_core", trigger: "field_confirmation" },
      })
    );
  });
});

describe("confirmar un campo que pesa en el puntaje", () => {
  it("con cambio de estado, el mismo UPDATE escribe el puntaje nuevo", async () => {
    responderConsultas(filaDelCaso({ pesos_puntaje: PESOS }), [{ field_key: "tiene_gnc", field_value: "si" }]);
    await confirmar("tiene_gnc", "si");

    const [estado] = lote();
    expect(estado!.sql).toContain('"puntaje_complejidad" = $');
    // Gravedad media: 0,5 x 10 más los 90 del campo, sobre 100.
    expect(estado!.params).toContain(95);
  });

  it("sin cambio de estado, un UPDATE sólo del puntaje", async () => {
    vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({ status: "confirmacion_pendiente" } as never);
    responderConsultas(filaDelCaso({ pesos_puntaje: PESOS }), [{ field_key: "tiene_gnc", field_value: "no" }]);

    const r = await confirmar("tiene_gnc", "no");

    expect(r.new_status).toBe("confirmacion_pendiente");
    expect(espias.enTenantVarias).not.toHaveBeenCalled();
    const escritura = espias.enTenant.mock.calls
      .map((c) => sqlDe((c[1] as (db: ClienteDatos) => unknown)(dbSuelta)))
      .find((q) => q.sql.includes('"puntaje_complejidad"'));
    expect(escritura!.sql).toMatch(/^update "cases" set "puntaje_complejidad" = \$1 where/);
    // Sólo la gravedad: 0,5 x 10 sobre 100.
    expect(escritura!.params[0]).toBe(5);
  });

  const escriturasDelPuntaje = () =>
    espias.enTenant.mock.calls
      .map((c) => sqlDe((c[1] as (db: ClienteDatos) => unknown)(dbSuelta)))
      .filter((q) => q.sql.startsWith('update "cases" set "puntaje_complejidad" = $1 where'));

  it("si lo del equipo falla y el estado se aplica con el respaldo, el puntaje recalculado igual se guarda", async () => {
    responderConsultas(filaDelCaso({ pesos_puntaje: PESOS }), [{ field_key: "tiene_gnc", field_value: "si" }]);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    espias.enTenantVarias.mockRejectedValue(Object.assign(new Error("column does not exist"), { code: "42703" }));

    const r = await confirmar("tiene_gnc", "si");

    expect(r.new_status).toBe("listo_para_core");
    const escrituras = escriturasDelPuntaje();
    expect(escrituras).toHaveLength(1);
    expect(escrituras[0]!.params[0]).toBe(95);
  });

  it("si otra mano ya movió el caso, el estado no se pisa pero el puntaje recalculado se guarda", async () => {
    responderConsultas(filaDelCaso({ pesos_puntaje: PESOS }), [{ field_key: "tiene_gnc", field_value: "si" }]);
    espias.enTenantVarias.mockResolvedValue([[]]);

    const r = await confirmar("tiene_gnc", "si");

    expect(r.new_status).toBe("confirmacion_pendiente");
    expect(escriturasDelPuntaje().map((q) => q.params[0])).toEqual([95]);
  });

  it("un campo que los pesos no cuentan no toca el puntaje", async () => {
    vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({ status: "confirmacion_pendiente" } as never);
    responderConsultas(filaDelCaso({ pesos_puntaje: PESOS }));
    await confirmar("full_name", "Juan Pérez");

    const tocaronElPuntaje = espias.enTenant.mock.calls.some((c) =>
      sqlDe((c[1] as (db: ClienteDatos) => unknown)(dbSuelta)).sql.includes("puntaje_complejidad")
    );
    expect(tocaronElPuntaje).toBe(false);
  });

  it("con los pesos por defecto ningún campo propio pesa", async () => {
    responderConsultas(filaDelCaso());
    await confirmar("tiene_gnc", "si");

    expect(lote()[0]!.sql).not.toContain("puntaje_complejidad");
  });
});

describe("rechazar", () => {
  it("no mira el estado ni arma nada del equipo", async () => {
    responderConsultas(filaDelCaso({ pesos_puntaje: PESOS }));
    await resolveFieldConfirmation({ tenantId: TENANT }, CASO, { field_key: "tiene_gnc", value: null, action: "reject" }, DUENO);

    expect(espias.enTenantVarias).not.toHaveBeenCalled();
    expect(analyzeEmailClaimGaps).not.toHaveBeenCalled();
  });
});
