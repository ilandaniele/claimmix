/**
 * `esDevolvible` — E24: el caso se devuelve sólo si lo último que le pasó fue
 * que alguien lo tomó con «Tomar el control». `noLoTomoUnaPersona` es la misma
 * regla dentro de una sentencia; se prueba con un cliente de drizzle que no se
 * conecta (`pg-proxy`) y arma el SQL de verdad.
 */

import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { ClienteDatos } from "@/data/scope";
import { cases } from "@/lib/db/schema";
import {
  consultaDelUltimoMovimiento,
  esDevolvible,
  noLoTomoUnaPersona,
} from "@/server/cases/devolver-al-agente";

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

  // Así lo usa `setStatus`: dentro del UPDATE, la correlación tiene que
  // seguir apuntando a la fila de `cases` que se actualiza.
  it("dentro de un UPDATE de cases, la correlación queda calificada", () => {
    const update = db
      .update(cases)
      .set({ status: "info_faltante" })
      .where(and(eq(cases.id, "case-1"), noLoTomoUnaPersona(db)))
      .toSQL();
    expect(update.sql).toMatch(/^update "cases"/);
    expect(update.sql).toContain('"cases"."id"::text');
  });
});

describe("consultaDelUltimoMovimiento", () => {
  const db = drizzle(async () => ({ rows: [] })) as unknown as ClienteDatos;

  // Lo que anotan el agente y el sistema no le saca el caso a quien lo tomó.
  it("cuenta sólo los movimientos de una persona", () => {
    expect(consultaDelUltimoMovimiento(db, "case-1").toSQL().sql).toContain('"actor_id" is not null');
  });

  // Los escribe la corrida con el `actor_id` de quien la lanzó: si contaran,
  // una corrida lanzada a mano que termina después de la toma la taparía.
  it("no cuenta lo que anota la corrida aunque la haya lanzado una persona", () => {
    const { params } = consultaDelUltimoMovimiento(db, "case-1").toSQL();
    expect(params).not.toContain("ai.extracted");
    expect(params).not.toContain("ai.budget_exceeded");
  });
});
