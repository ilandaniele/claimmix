/**
 * La 0052 se aplica a mano, en tres bases y en las de cliente, y puede correr más de
 * una vez. Trae los índices que la integridad referencial necesita al borrar casos:
 * cada FK a claim_messages, cases y agent_runs desde agent_runs y training_examples
 * tiene que tener un índice que empiece por esa columna.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";

const CARPETA = join(process.cwd(), "neon/migrations");
const ARCHIVO = "0052_indices_de_fk.sql";
const SQL = readFileSync(join(CARPETA, ARCHIVO), "utf8")
  .split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const sentencias: string[] = splitSqlStatements(SQL).map((s: string) => s.replace(/\s+/g, " ").trim());

describe("migración 0052: índices de las FK", () => {
  it("es la única con el número 0052, y viene justo después de la 0051", () => {
    const archivos = readdirSync(CARPETA).filter((f) => f.endsWith(".sql"));

    expect(archivos.filter((f) => f.startsWith("0052_"))).toEqual([ARCHIVO]);
    expect(archivos.some((f) => f.startsWith("0051_"))).toBe(true);
  });

  it.each([
    ["idx_agent_runs_claim_message", "agent_runs", "claim_message_id", " WHERE claim_message_id IS NOT NULL"],
    ["idx_training_examples_case", "training_examples", "case_id", " WHERE case_id IS NOT NULL"],
    ["idx_training_examples_claim_message", "training_examples", "claim_message_id", " WHERE claim_message_id IS NOT NULL"],
    ["idx_training_examples_run", "training_examples", "agent_run_id", ""],
  ])("%s: %s(%s), repetible", (nombre, tabla, columna, parcial) => {
    expect(sentencias).toContain(`CREATE INDEX IF NOT EXISTS ${nombre} ON public.${tabla} (${columna})${parcial}`);
  });

  it("sólo crea esos índices: sin CONCURRENTLY, sin tocar datos ni otros índices", () => {
    expect(sentencias).toHaveLength(4);
    expect(sentencias.every((s) => s.startsWith("CREATE INDEX IF NOT EXISTS "))).toBe(true);
    expect(SQL).not.toMatch(/CONCURRENTLY|idx_extracted_fields_case_id/);
  });
});
