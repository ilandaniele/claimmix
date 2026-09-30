/**
 * La 0041 se aplica a mano, en tres bases, y puede correr más de una vez: sólo
 * agrega una columna que admite NULL, sin tablas, políticas ni permisos nuevos,
 * y no toca filas.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";

const SQL = readFileSync(join(process.cwd(), "neon/migrations/0041_responsabilidad_en_choques.sql"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const sentencias: string[] = splitSqlStatements(SQL).map((s: string) => s.replace(/\s+/g, " ").trim());
const plano = sentencias.join(";\n");

describe("migración 0041", () => {
  it("agrega la columna de responsabilidad, NULL por omisión", () => {
    expect(sentencias).toEqual(["ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS responsabilidad jsonb"]);
  });

  it("ni tablas, ni RLS, ni permisos, ni restricciones que validen filas viejas", () => {
    expect(plano).not.toMatch(/\b(CREATE|DROP|GRANT|REVOKE|POLICY|NOT NULL|DEFAULT|CHECK|REFERENCES)\b/i);
  });

  it("no siembra ni toca datos", () => {
    expect(plano).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|TRUNCATE\s+(TABLE\s+)?public|COPY)\b/i);
  });
});
