/**
 * `esDevolvible` — E24: el caso se devuelve sólo si lo último que le pasó fue
 * que alguien lo tomó con «Tomar el control». `noLoTomoUnaPersona` es la misma
 * regla dentro de una sentencia; se prueba con un cliente de drizzle que no se
 * conecta (`pg-proxy`) y arma el SQL de verdad.
 */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { ClienteDatos } from "@/data/scope";
import { esDevolvible, noLoTomoUnaPersona } from "@/server/cases/devolver-al-agente";

describe("esDevolvible", () => {
  it("da false sin movimiento previo", () => {
    expect(esDevolvible(undefined)).toBe(false);
  });

  it("da true con case.status_changed, reason tomar_el_control, new_status requiere_especialista", () => {
    expect(
      esDevolvible({
        event_type: "case.status_changed",
        payload: { reason: "tomar_el_control", new_status: "requiere_especialista" },
      })
    ).toBe(true);
  });

  it("da false con otro evento (claim.specialist_required)", () => {
    expect(esDevolvible({ event_type: "claim.specialist_required", payload: {} })).toBe(false);
  });

  it("da false con case.status_changed pero otro motivo", () => {
    expect(
      esDevolvible({
        event_type: "case.status_changed",
        payload: { reason: "lesiones", new_status: "requiere_especialista" },
      })
    ).toBe(false);
  });

  it("da false con case.re_analyze_triggered (no es un cambio de estado)", () => {
    expect(esDevolvible({ event_type: "case.re_analyze_triggered", payload: {} })).toBe(false);
  });
});

describe("noLoTomoUnaPersona", () => {
  const db = drizzle(async () => ({ rows: [] })) as unknown as ClienteDatos;
  const { sql, params } = new PgDialect().sqlToQuery(noLoTomoUnaPersona(db));

  it("es un not exists correlacionado con cases.id, sobre el último movimiento", () => {
    expect(sql).toContain("not exists");
    expect(sql).toContain('"cases"."id"::text');
    expect(sql).toContain("->>'reason'");
    expect(sql).toContain("order by");
  });

  it("compara con la toma: motivo, evento y estado", () => {
    expect(params).toEqual(
      expect.arrayContaining(["tomar_el_control", "case.status_changed", "requiere_especialista"])
    );
  });
});
