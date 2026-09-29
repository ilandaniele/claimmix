/**
 * La 0039 se aplica a mano, en tres bases, y puede correr más de una vez: cada
 * sentencia tiene que poder repetirse sin error y ninguna puede sembrar datos.
 * `case_recordatorios` es la idempotencia de los recordatorios: si la app
 * pudiera reescribir o borrar una etapa, el barrido la volvería a mandar.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";
import { PERMISOS_QUITADOS } from "../../scripts/lib/permisos-quitados.mjs";

const SQL = readFileSync(join(process.cwd(), "neon/migrations/0039_recordatorios.sql"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const sentencias: string[] = splitSqlStatements(SQL).map((s: string) => s.replace(/\s+/g, " ").trim());
const plano = sentencias.join(";\n");

describe("migración 0039", () => {
  it("agrega recordatorio_horas apagado por omisión", () => {
    expect(plano).toMatch(
      /ALTER TABLE public\.tenants ADD COLUMN IF NOT EXISTS recordatorio_horas integer\[\] NOT NULL DEFAULT '\{\}'/
    );
  });

  it("la clave primaria de case_recordatorios es la idempotencia: caso, ancla y etapa", () => {
    expect(plano).toMatch(/CREATE TABLE IF NOT EXISTS public\.case_recordatorios/);
    expect(plano).toMatch(/case_id uuid NOT NULL REFERENCES public\.cases\(id\) ON DELETE CASCADE/);
    expect(plano).toMatch(/PRIMARY KEY \(case_id, ancla, etapa\)/);
  });

  it("fuerza RLS con políticas sólo de SELECT e INSERT", () => {
    expect(plano).toMatch(/ALTER TABLE public\.case_recordatorios ENABLE ROW LEVEL SECURITY/);
    expect(plano).toMatch(/ALTER TABLE public\.case_recordatorios FORCE ROW LEVEL SECURITY/);
    expect(plano).toMatch(
      /CREATE POLICY claimmix_tenant_isolation_select ON public\.case_recordatorios FOR SELECT USING \(public\.claimmix_tenant_matches\(tenant_id\)\)/
    );
    expect(plano).toMatch(
      /CREATE POLICY claimmix_tenant_isolation_insert ON public\.case_recordatorios FOR INSERT WITH CHECK \(public\.claimmix_tenant_matches\(tenant_id\)\)/
    );
    expect(plano.match(/CREATE POLICY/g)).toHaveLength(2);
  });

  it("las políticas sólo se crean si no están", () => {
    const bloque = sentencias.find((s) => s.includes("CREATE POLICY")) ?? "";
    expect(bloque.match(/IF NOT EXISTS \( SELECT 1 FROM pg_policies/g)).toHaveLength(2);
  });

  it("claimmix_app lee e inserta, y no reescribe ni borra, sólo si el rol existe", () => {
    const bloque = sentencias.find((s) => s.includes("REVOKE")) ?? "";
    expect(bloque).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app'\)/);
    expect(bloque).toMatch(/GRANT SELECT, INSERT ON public\.case_recordatorios TO claimmix_app/);
    expect(bloque).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON public\.case_recordatorios FROM claimmix_app/);
    expect(bloque).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)/);
  });

  it("coincide con la lista que sostienen create-app-role y pnpm permisos", () => {
    expect(PERMISOS_QUITADOS.case_recordatorios).toEqual(["UPDATE", "DELETE"]);
  });

  it("cada sentencia se puede repetir", () => {
    for (const s of sentencias) {
      const repetible =
        /^ALTER TABLE \S+ ADD COLUMN IF NOT EXISTS /.test(s) ||
        /^CREATE TABLE IF NOT EXISTS /.test(s) ||
        /^DO \$\$ BEGIN IF (NOT )?EXISTS /.test(s) ||
        /^ALTER TABLE \S+ (ENABLE|FORCE) ROW LEVEL SECURITY$/.test(s) ||
        /^COMMENT ON /.test(s);
      expect(repetible, s.slice(0, 80)).toBe(true);
    }
  });

  it("no siembra ni toca datos", () => {
    expect(plano).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|TRUNCATE\s+(TABLE\s+)?public|COPY)\b/i);
  });
});
