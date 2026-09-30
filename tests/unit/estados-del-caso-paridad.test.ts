/**
 * Los estados del caso viven en cuatro lugares: el CHECK de la base (migración
 * 0035), el esquema de Zod, el enum de Drizzle y el grafo de la máquina de
 * estados. Si uno se queda atrás, el PATCH da 23514 o un estado no tiene fila en
 * `FSM_TRANSITIONS`. Este test los ata.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { FSM_TRANSITIONS } from "@/core/case/fsm";
import { cases } from "@/lib/db/schema/core";
import { CaseStatusSchema } from "@/lib/schemas/cases";

const MIGRACION = readFileSync(
  "neon/migrations/0035_estados_de_liquidacion.sql",
  "utf8"
);
// Sin los comentarios, que citan sentencias de la vuelta atrás.
const SQL = MIGRACION.split(/\r?\n/)
  .filter((linea) => !linea.trimStart().startsWith("--"))
  .join("\n");

function estadosDelCheck(): string[] {
  const lista = /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/i.exec(SQL);
  if (!lista) throw new Error("La migración no tiene el CHECK de status.");
  return [...lista[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe("paridad de los estados del caso (0035)", () => {
  it("el CHECK tiene dieciséis estados, sin repetidos", () => {
    const check = estadosDelCheck();
    expect(check).toHaveLength(16);
    expect(new Set(check).size).toBe(16);
  });

  it("el CHECK, Zod, Drizzle y el grafo nombran los mismos estados", () => {
    const check = estadosDelCheck().sort();
    expect([...CaseStatusSchema.options].sort()).toEqual(check);
    expect([...cases.status.enumValues].sort()).toEqual(check);
    expect(Object.keys(FSM_TRANSITIONS).sort()).toEqual(check);
  });

  it("es idempotente: cada DROP lleva IF EXISTS", () => {
    const drops = SQL.match(/\bDROP\s+CONSTRAINT\b[^;]*/gi) ?? [];
    expect(drops.length).toBeGreaterThan(0);
    for (const drop of drops) expect(drop).toMatch(/\bIF\s+EXISTS\b/i);
  });

  // Una columna que Drizzle conoce y la base no rompe con 42703 todo INSERT y
  // RETURNING de `cases`, ingesta incluida, hasta que alguien aplique la 0035.
  it("no agrega columnas: el código puede llegar antes que la migración", () => {
    expect(SQL).not.toMatch(/\bADD\s+COLUMN\b/i);
  });

  it("no siembra ni toca filas", () => {
    expect(SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
});
