/**
 * La sentencia que tilda o destilda un paso del plan (B11).
 *
 * El permiso sobre el caso lo decide la base dentro del WHERE, así que sin base
 * lo que se puede afirmar es la forma de la sentencia y lo que viaja como
 * parámetro: una sola, con la auditoría adentro, el actor, el destildado que
 * borra `hecho_en` y `hecho_por`, y que un paso que ya está como se pide no se
 * vuelve a sellar ni a auditar.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { AppError } from "@/lib/errors";

vi.mock("server-only", () => ({}));

const { mockEnTenant } = vi.hoisted(() => ({ mockEnTenant: vi.fn() }));
vi.mock("@/data/scope", () => ({ enTenant: mockEnTenant }));

import { marcarPaso } from "@/server/cases/plan-de-trabajo";

const CTX = { tenantId: "tenant-1" };
const CASO = "123e4567-e89b-12d3-a456-426614174001";
const ACTOR = "20000000-0000-0000-0000-000000000001";

const dialecto = new PgDialect();
const sentencias: Array<{ sql: string; params: unknown[] }> = [];

/** `enTenant` reemplazado: anota la sentencia que armó la función y contesta con `resultado`. */
function responder(resultado: unknown) {
  sentencias.length = 0;
  mockEnTenant.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) => {
    const consulta = armar({ execute: (q: SQL) => q }) as SQL;
    const { sql, params } = dialecto.sqlToQuery(consulta);
    sentencias.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    return resultado;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("marcarPaso", () => {
  it("es una sola sentencia, en el inquilino de la sesión, que actualiza el paso y lo audita", async () => {
    responder({ rows: [{ n: 1 }] });

    await marcarPaso(CTX, CASO, "pedir_presupuesto", true, { id: ACTOR, role: "analyst" });

    expect(mockEnTenant).toHaveBeenCalledTimes(1);
    expect(mockEnTenant.mock.calls[0]?.[0]).toEqual(CTX);
    expect(sentencias).toHaveLength(1);
    const { sql } = sentencias[0];
    expect(sql).toContain("UPDATE case_plan_pasos");
    expect(sql).toContain("INSERT INTO audit_log");
    expect(sql).toContain("origen = 'manual'");
    expect(sql).toContain("jsonb_build_object('clave', clave, 'hecho', $");
    expect(sql).toContain("'origen', 'manual'");
    expect(sql).toContain("SELECT count(*)::int AS n FROM tocable");
  });

  it("un paso que ya está como se pide no se toca ni se audita, pero se cuenta como encontrado", async () => {
    responder({ rows: [{ n: 1 }] });

    await marcarPaso(CTX, CASO, "pedir_presupuesto", true, { id: ACTOR, role: "analyst" });

    const { sql } = sentencias[0];
    // El UPDATE y, por lo tanto, la auditoría —que lee de `paso`— sólo ven los pasos que cambian de estado.
    expect(sql).toMatch(/FROM tocable t WHERE p\.case_id = t\.case_id AND p\.clave = t\.clave AND t\.hecho IS DISTINCT FROM \$\d+::boolean RETURNING/);
    expect(sql).toMatch(/FROM paso RETURNING 1/);
    // El conteo sale de los pasos que el actor puede tocar, cambien o no.
    expect(sql).toMatch(/SELECT count\(\*\)::int AS n FROM tocable$/);
    expect(sql).toContain("p.hecho_en IS NOT NULL AS hecho");
  });

  it("la auditoría lleva quién lo hizo y el tipo de evento", async () => {
    responder({ rows: [{ n: 1 }] });

    await marcarPaso(CTX, CASO, "pedir_presupuesto", true, { id: ACTOR, role: "analyst" });

    const { params } = sentencias[0];
    expect(params).toContain("case.plan_step");
    // El actor va en `hecho_por`, en el chequeo del caso y en la auditoría.
    expect(params.filter((p) => p === ACTOR)).toHaveLength(3);
  });

  it("tildar guarda cuándo y quién; destildar los deja NULL y registra hecho false", async () => {
    responder({ rows: [{ n: 1 }] });

    await marcarPaso(CTX, CASO, "pedir_presupuesto", true, { id: ACTOR, role: "analyst" });
    await marcarPaso(CTX, CASO, "pedir_presupuesto", false, { id: ACTOR, role: "analyst" });

    const [tildar, destildar] = sentencias;
    for (const s of sentencias) {
      // Sin ELSE, el CASE da NULL: es lo que deja `hecho_en` y `hecho_por` vacíos.
      expect(s.sql).toMatch(/hecho_en = CASE WHEN \$\d+::boolean THEN now\(\) END/);
      expect(s.sql).toMatch(/hecho_por = CASE WHEN \$\d+::boolean THEN \$\d+::uuid END/);
      expect(s.sql).not.toContain("ELSE");
    }
    // El booleano que decide va en el SET y en la comparación con lo que hay; el que se audita es el último.
    expect([tildar.params[4], tildar.params[5], tildar.params[7], tildar.params.at(-1)]).toEqual([true, true, true, true]);
    expect([destildar.params[4], destildar.params[5], destildar.params[7], destildar.params.at(-1)]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("manda el paso y el caso como parámetros, no pegados en el texto", async () => {
    responder({ rows: [{ n: 1 }] });

    await marcarPaso(CTX, CASO, "pedir_presupuesto", true, { id: ACTOR, role: "analyst" });

    const { sql, params } = sentencias[0];
    expect(params).toContain(CASO);
    expect(params).toContain("pedir_presupuesto");
    expect(sql).not.toContain("pedir_presupuesto");
    expect(sql).not.toContain(CASO);
  });

  it("el permiso va adentro: rol amplio, caso libre o caso propio", async () => {
    responder({ rows: [{ n: 1 }] });

    await marcarPaso(CTX, CASO, "pedir_presupuesto", true, { id: ACTOR, role: "analyst" });

    expect(sentencias[0].sql).toMatch(
      /AND \(\$\d+::boolean OR c\.assigned_to IS NULL OR c\.assigned_to = \$\d+::uuid\)/
    );
  });

  it.each([
    ["owner", true],
    ["admin", true],
    ["specialist", true],
    ["analyst", false],
  ])("%s: el permiso amplio es %s", async (role, amplio) => {
    responder({ rows: [{ n: 1 }] });

    await marcarPaso(CTX, CASO, "pedir_presupuesto", true, { id: ACTOR, role });

    // caso, clave, AMPLIO, actor, hecho, hecho, actor, hecho, actor, evento, hecho.
    expect(sentencias[0].params).toEqual([
      CASO,
      "pedir_presupuesto",
      amplio,
      ACTOR,
      true,
      true,
      ACTOR,
      true,
      ACTOR,
      "case.plan_step",
      true,
    ]);
  });

  it("dice true si el paso existe y el actor puede tocarlo", async () => {
    responder({ rows: [{ n: 1 }] });
    expect(await marcarPaso(CTX, CASO, "k", true, { id: ACTOR, role: "owner" })).toBe(true);
  });

  it("dice true también si el driver devuelve un arreglo", async () => {
    responder([{ n: 1 }]);
    expect(await marcarPaso(CTX, CASO, "k", true, { id: ACTOR, role: "owner" })).toBe(true);
  });

  // Un analista en el caso de otro y una clave que no existe terminan igual: cero filas.
  it.each([
    ["cero filas", { rows: [{ n: 0 }] }],
    ["sin filas", { rows: [] }],
    ["un resultado vacío", undefined],
    ["un conteo que no es un número", { rows: [{ n: "x" }] }],
  ])("dice false con %s", async (_caso, resultado) => {
    responder(resultado);
    expect(await marcarPaso(CTX, CASO, "k", true, { id: ACTOR, role: "analyst" })).toBe(false);
  });

  it.each(["42P01", "42703"])("%s es la migración 0042 pendiente", async (code) => {
    mockEnTenant.mockRejectedValue(Object.assign(new Error("Failed query"), { cause: { code } }));

    const e = await marcarPaso(CTX, CASO, "k", true, { id: ACTOR, role: "owner" }).catch((x: unknown) => x);

    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "MIGRACION_PENDIENTE" });
    expect((e as Error).message).toContain("0042");
  });

  it("cualquier otro error sigue igual", async () => {
    mockEnTenant.mockRejectedValue(Object.assign(new Error("se cayó"), { code: "57P01" }));

    await expect(marcarPaso(CTX, CASO, "k", true, { id: ACTOR, role: "owner" })).rejects.toMatchObject({
      code: "57P01",
    });
  });
});
