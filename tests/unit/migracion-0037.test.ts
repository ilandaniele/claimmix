/**
 * La 0037 se aplica a mano en tres bases, y puede correr dos veces en la misma
 * sin romper nada: sólo agrega columnas, todas con IF NOT EXISTS, sin DEFAULT
 * que reescriba la tabla y sin sembrar filas.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SQL = readFileSync("neon/migrations/0037_lectura_de_adjuntos.sql", "utf8");
const SENTENCIAS = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

describe("migración 0037", () => {
  it("sólo agrega columnas, y cada una es idempotente", () => {
    expect(SENTENCIAS).toHaveLength(5);
    for (const s of SENTENCIAS) {
      expect(s).toMatch(/^ALTER TABLE public\.(cases|claim_attachments) ADD COLUMN IF NOT EXISTS \w+ (text|boolean|jsonb)$/);
    }
  });

  it("agrega exactamente las cinco columnas que lee el código", () => {
    const columnas = SENTENCIAS.map((s) => s.match(/public\.(\w+) ADD COLUMN IF NOT EXISTS (\w+)/)!.slice(1).join("."));
    expect(columnas).toEqual([
      "cases.resumen",
      "claim_attachments.resumen",
      "claim_attachments.util",
      "claim_attachments.datos",
      "claim_attachments.metadatos",
    ]);
  });

  it("dice cómo aplicarla y cómo volver atrás, y no siembra datos", () => {
    expect(SQL).toMatch(/STAGING[\s\S]*QA[\s\S]*Producción/);
    expect(SQL).toContain("No siembra datos de prueba");
    expect(SQL).toContain("node scripts/migrate.mjs --env <VAR> --forget 0037");
    expect(SENTENCIAS.join("\n")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/);
  });
});
