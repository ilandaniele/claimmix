/**
 * El cambio de estado del agente y lo que lo acompaña: la auditoría del cambio
 * (B14) y, para el equipo, vence, a quién le toca y el plan. Salen en el mismo
 * lote que el estado, y si algo de eso falla el estado se aplica igual.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClienteDatos } from "@/data/scope";
import * as schema from "@/lib/db/schema";

const espias = vi.hoisted(() => ({ enTenant: vi.fn(), enTenantVarias: vi.fn() }));

vi.mock("@/data/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/scope")>()),
  enTenant: espias.enTenant,
  enTenantVarias: espias.enTenantVarias,
}));

vi.mock("@/lib/db", () => ({ db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() }, tables: {} }));
vi.mock("@/server/email/dispatch", () => ({ dispatchOutboundEmail: vi.fn(), seEntrego: () => true }));
vi.mock("@/server/ai/deliberate", () => ({ deliberate: vi.fn() }));
vi.mock("@/server/notify/specialist-alert", () => ({ alertSpecialists: vi.fn() }));

import { logger } from "@/lib/observability/logger";
import { setStatus } from "@/server/confirmations/orchestrate";
import type { CriteriosDeTrabajo } from "@/server/cases/efectos-de-transicion";

const dialecto = new PgDialect();
const sqlDe = (q: unknown) => dialecto.sqlToQuery((q as { getSQL(): never }).getSQL());
// Arma las consultas sin conectarse: nadie las espera.
const dbSuelta = drizzle(neon("postgres://u:p@localhost/db"), { schema }) as unknown as ClienteDatos;

const CASO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ANA = "11111111-1111-4111-8111-111111111111";
const TRABAJO: CriteriosDeTrabajo = {
  tipo: "choque",
  reglas: { reglas: [{ tipos: ["choque"], personas: [ANA] }] },
  plazos: [],
  plan: null,
};

/** Lo que enTenantVarias recibió en su llamada `n`, armado contra una base suelta. */
function lote(n = 0): unknown[] {
  const armar = espias.enTenantVarias.mock.calls[n]![1] as (db: ClienteDatos) => unknown[];
  return armar(dbSuelta);
}

beforeEach(() => {
  vi.clearAllMocks();
  espias.enTenant.mockResolvedValue([{ id: CASO }]);
  // [auditoría, estado, ...efectos]: sólo el UPDATE de estado devuelve filas.
  espias.enTenantVarias.mockResolvedValue([[], [{ id: CASO }]]);
});

describe("setStatus con criterios de trabajo", () => {
  it("listo_para_core va en un solo lote: auditoría, estado con vencimiento, asignación y plan", async () => {
    expect(await setStatus(CASO, TENANT, "listo_para_core", TRABAJO)).toBe(true);
    expect(espias.enTenantVarias).toHaveBeenCalledTimes(1);
    expect(espias.enTenant).not.toHaveBeenCalled();

    const [auditoria, estado, asigna, plan, ...resto] = lote().map(sqlDe);
    expect(resto).toEqual([]);
    expect(auditoria!.sql).toMatch(/^insert into "audit_log"/);
    expect(estado!.sql).toMatch(/^update "cases" set "status" = \$\d+/);
    expect(estado!.sql).toContain('"vence_en" = CASE WHEN');
    expect(estado!.sql).toContain('"vence_plazo" = CASE WHEN');
    expect(estado!.sql).toContain("returning");
    expect(asigna!.sql).toContain("UPDATE cases c SET assigned_to");
    expect(plan!.sql).toContain("INSERT INTO case_plan_pasos");
  });

  it("los efectos los pide el agente: sin actor, y la asignación sale en la auditoría como automática", async () => {
    await setStatus(CASO, TENANT, "listo_para_core", TRABAJO);
    const [, , asigna, plan] = lote().map(sqlDe);
    expect(asigna!.sql).toContain("NULL::uuid");
    expect(asigna!.sql).toContain("'auto', true");
    expect(plan!.params).toContain("agente");
  });

  it("requiere_especialista asigna pero no arma el plan ni toca el vencimiento", async () => {
    await setStatus(CASO, TENANT, "requiere_especialista", TRABAJO);
    const [, estado, asigna, ...resto] = lote().map(sqlDe);
    expect(resto).toEqual([]);
    expect(estado!.sql).not.toContain("vence_en");
    expect(asigna!.sql).toContain("SET assigned_to");
  });

  it("un estado de espera va con el UPDATE de siempre, sin nada del equipo", async () => {
    await setStatus(CASO, TENANT, "info_faltante", TRABAJO);
    const [, estado, ...resto] = lote().map(sqlDe);
    expect(resto).toEqual([]);
    expect(estado!.sql).not.toContain("vence_en");
  });

  it("si lo del equipo falla, el estado se aplica igual, con su auditoría, y queda el aviso", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    espias.enTenantVarias
      .mockRejectedValueOnce(Object.assign(new Error("column does not exist"), { code: "42703" }))
      .mockResolvedValueOnce([[], [{ id: CASO }]]);

    expect(await setStatus(CASO, TENANT, "listo_para_core", TRABAJO)).toBe(true);

    // Segundo lote: la auditoría y el estado, sin vencimiento, asignación ni plan; y ya no hace falta el UPDATE solo.
    expect(espias.enTenantVarias).toHaveBeenCalledTimes(2);
    expect(espias.enTenant).not.toHaveBeenCalled();
    const [auditoria, estado, ...resto] = lote(1).map(sqlDe);
    expect(resto).toEqual([]);
    expect(auditoria!.sql).toMatch(/^insert into "audit_log"/);
    expect(auditoria!.params).toEqual(expect.arrayContaining([CASO, "case.status_changed", "listo_para_core"]));
    expect(estado!.sql).toMatch(/^update "cases" set "status"/);
    expect(estado!.sql).not.toContain("vence_en");
    expect(aviso).toHaveBeenCalledWith(
      expect.objectContaining({ case_id: CASO, con_efectos: true }),
      "orchestrate.efectos_fallaron"
    );
  });

  it("si falla hasta la auditoría, el último recurso es el UPDATE solo", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    espias.enTenantVarias.mockRejectedValue(Object.assign(new Error("column does not exist"), { code: "42703" }));

    expect(await setStatus(CASO, TENANT, "listo_para_core", TRABAJO)).toBe(true);

    expect(espias.enTenantVarias).toHaveBeenCalledTimes(2);
    expect(espias.enTenant).toHaveBeenCalledTimes(1);
    const armar = espias.enTenant.mock.calls[0]![1] as (db: ClienteDatos) => unknown;
    const q = sqlDe(armar(dbSuelta));
    expect(q.sql).not.toContain("vence_en");
    expect(q.sql).toMatch(/^update "cases" set "status"/);
  });

  it("si el caso ya lo movió otra mano no se aplica y no se cae al UPDATE de siempre", async () => {
    espias.enTenantVarias.mockResolvedValue([[], []]);
    expect(await setStatus(CASO, TENANT, "listo_para_core", TRABAJO)).toBe(false);
    expect(espias.enTenant).not.toHaveBeenCalled();
  });
});

describe("setStatus sin criterios", () => {
  it("va en un lote de dos, la auditoría y el UPDATE, sin efectos del equipo", async () => {
    expect(await setStatus(CASO, TENANT, "listo_para_core")).toBe(true);
    expect(espias.enTenant).not.toHaveBeenCalled();
    const [auditoria, estado, ...resto] = lote().map(sqlDe);
    expect(resto).toEqual([]);
    expect(auditoria!.sql).toMatch(/^insert into "audit_log"/);
    expect(estado!.sql).toMatch(/^update "cases" set "status"/);
    expect(estado!.sql).not.toContain("vence_en");
  });

  it("devuelve false cuando la guarda no dejó pasar ninguna fila", async () => {
    espias.enTenantVarias.mockResolvedValue([[], []]);
    expect(await setStatus(CASO, TENANT, "info_faltante")).toBe(false);
  });

  it("si el lote falla —la auditoría incluida— el estado se aplica igual con el UPDATE de siempre", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    espias.enTenantVarias.mockRejectedValue(new Error("boom"));
    expect(await setStatus(CASO, TENANT, "info_faltante")).toBe(true);
    // Sin criterios el lote ya era auditoría y estado: no hay un segundo intento igual.
    expect(espias.enTenantVarias).toHaveBeenCalledTimes(1);
    expect(espias.enTenant).toHaveBeenCalledTimes(1);
    expect(aviso).toHaveBeenCalledWith(expect.objectContaining({ case_id: CASO }), "orchestrate.efectos_fallaron");
  });
});

describe("la auditoría del cambio de estado del agente", () => {
  it("guarda el cambio con el estado de antes y no la repetición del mismo estado", async () => {
    await setStatus(CASO, TENANT, "listo_para_core");
    const [auditoria] = lote().map(sqlDe);
    const q = auditoria!;
    expect(q.sql).toContain("jsonb_build_object('from', \"status\"::text, 'old_status', \"status\"::text");
    // Sólo si cambia: el estado de antes es de los que el agente pisa y distinto del nuevo.
    expect(q.sql).toContain('"cases"."status" in (');
    expect(q.sql).toMatch(/"cases"\."status" <> \$\d+/);
    expect(q.params).toEqual(
      expect.arrayContaining([CASO, "case.status_changed", '{"trigger":"agent"}', "listo_para_core"])
    );
  });

  it("no lleva actor ni IP: es del agente", async () => {
    await setStatus(CASO, TENANT, "info_faltante");
    const [auditoria] = lote().map(sqlDe);
    expect(auditoria!.params).toContain(null);
    expect(auditoria!.sql).toContain("::uuid");
    expect(auditoria!.sql).toContain("::inet");
  });

  it("va antes del UPDATE: después ya no queda el estado de antes", async () => {
    await setStatus(CASO, TENANT, "listo_para_core", TRABAJO);
    const sentencias = lote().map(sqlDe);
    expect(sentencias[0]!.sql).toMatch(/^insert into "audit_log"/);
    expect(sentencias[1]!.sql).toMatch(/^update "cases"/);
  });
});
