/**
 * La migración 0054 — a qué caso pertenece cada llamada a la IA.
 *
 * Es una sola columna nueva y nula, y lo que importa no es lo que hace sino lo
 * que NO hace: sin FK (control recibe la misma fila y no tiene cases), sin
 * índice (un CREATE INDEX sin CONCURRENTLY dentro de la transacción del runner
 * frena las escrituras), sin backfill y sin tocar el acumulador de la 0046. Y
 * que su cabecera diga cómo aplicarla, porque Drizzle nombra la columna en cada
 * INSERT y el código sin ella da 42703.
 */

import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";
import { aiUsage, aiUsageMensual } from "@/lib/db/schema/core";

const DIR = join(process.cwd(), "neon", "migrations");

const archivos = readdirSync(DIR).filter((f) => f.startsWith("0054_"));
const cruda = readFileSync(join(DIR, archivos[0]), "utf8");
const sinComentarios = cruda
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("migración 0054", () => {
  it("es el único archivo 0054 y sigue a la 0053", () => {
    expect(archivos).toHaveLength(1);
    expect(readdirSync(DIR).filter((f) => f.startsWith("0053_"))).toHaveLength(1);
  });

  it("es una sola sentencia: la columna nueva, repetible", () => {
    expect(splitSqlStatements(sinComentarios).map((s: string) => s.replace(/\s+/g, " ").trim())).toEqual([
      "ALTER TABLE public.ai_usage ADD COLUMN IF NOT EXISTS case_id uuid",
    ]);
  });

  it("no lleva FK, índice, default, NOT NULL, backfill, permisos ni toca el acumulador", () => {
    expect(sinComentarios).not.toMatch(
      /GRANT|POLICY|UPDATE|NOT NULL|DEFAULT|REFERENCES|INDEX|CONCURRENTLY|TRIGGER|ai_usage_mensual/i
    );
  });

  it("la cabecera dice cómo aplicarla: a mano, en orden, y qué pasa si no", () => {
    expect(cruda).toContain("A MANO");
    expect(cruda).toContain("42703");
    expect(cruda).toContain("EXCEPT");
    expect(cruda).toContain("DROP COLUMN");
    expect(cruda).toContain("canal de casos");

    const orden = ["ep-wispy-flower", "ep-proud-resonance", "STAGING_DATABASE_URL", "migrar-bases.mjs --env prd"].map(
      (t) => cruda.indexOf(t)
    );
    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
  });

  it("el esquema la declara nula, sin default; el acumulador no la tiene", () => {
    const col = getTableColumns(aiUsage).case_id;

    expect(col.name).toBe("case_id");
    expect(col.getSQLType()).toBe("uuid");
    expect(col.notNull).toBe(false);
    expect(col.hasDefault).toBe(false);
    expect(getTableColumns(aiUsageMensual)).not.toHaveProperty("case_id");
  });
});
