/**
 * La 0042 se aplica a mano, en tres bases, y puede correr más de una vez: cada
 * sentencia tiene que poder repetirse sin error y ninguna puede sembrar datos.
 * `case_plan_pasos` es del equipo: con RLS forzada y sin DELETE para la app.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";
import { PERMISOS_QUITADOS } from "../../scripts/lib/permisos-quitados.mjs";

const CRUDO = readFileSync(join(process.cwd(), "neon/migrations/0042_asignacion_plazos_plan_puntaje.sql"), "utf8");
const SQL = CRUDO.split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const sentencias: string[] = splitSqlStatements(SQL).map((s: string) => s.replace(/\s+/g, " ").trim());
const plano = sentencias.join(";\n");

describe("migración 0042", () => {
  it("suma las tres columnas de cases, todas opcionales", () => {
    for (const [col, tipo] of [
      ["puntaje_complejidad", "smallint"],
      ["vence_en", "timestamptz"],
      ["vence_plazo", "text"],
    ]) {
      expect(sentencias).toContain(`ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS ${col} ${tipo}`);
    }
  });

  it("suma las cuatro columnas jsonb de tenants, todas opcionales", () => {
    for (const col of ["reglas_asignacion", "plazos", "plan_por_tipo", "pesos_puntaje"]) {
      expect(sentencias).toContain(`ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS ${col} jsonb`);
    }
  });

  it("las columnas nuevas no llevan DEFAULT, CHECK ni NOT NULL", () => {
    for (const s of sentencias.filter((x) => x.startsWith("ALTER TABLE") && x.includes("ADD COLUMN"))) {
      expect(s, s).not.toMatch(/DEFAULT|CHECK|NOT NULL|REFERENCES/);
    }
  });

  it("la clave primaria de case_plan_pasos es caso y clave", () => {
    expect(plano).toMatch(/CREATE TABLE IF NOT EXISTS public\.case_plan_pasos/);
    expect(plano).toMatch(/case_id uuid NOT NULL REFERENCES public\.cases\(id\) ON DELETE CASCADE/);
    expect(plano).toMatch(/hecho_por uuid REFERENCES public\.users\(id\) ON DELETE SET NULL/);
    expect(plano).toMatch(/PRIMARY KEY \(case_id, clave\)/);
  });

  it("fuerza RLS con tres políticas por aseguradora", () => {
    expect(plano).toMatch(/ALTER TABLE public\.case_plan_pasos ENABLE ROW LEVEL SECURITY/);
    expect(plano).toMatch(/ALTER TABLE public\.case_plan_pasos FORCE ROW LEVEL SECURITY/);
    expect(plano).toMatch(
      /CREATE POLICY claimmix_tenant_isolation_select ON public\.case_plan_pasos FOR SELECT USING \(public\.claimmix_tenant_matches\(tenant_id\)\)/
    );
    expect(plano).toMatch(
      /CREATE POLICY claimmix_tenant_isolation_insert ON public\.case_plan_pasos FOR INSERT WITH CHECK \(public\.claimmix_tenant_matches\(tenant_id\)\)/
    );
    expect(plano).toMatch(
      /CREATE POLICY claimmix_tenant_isolation_update ON public\.case_plan_pasos FOR UPDATE USING \(public\.claimmix_tenant_matches\(tenant_id\)\) WITH CHECK \(public\.claimmix_tenant_matches\(tenant_id\)\)/
    );
    expect(plano.match(/CREATE POLICY/g)).toHaveLength(3);
  });

  it("las políticas sólo se crean si no están", () => {
    const bloque = sentencias.find((s) => s.includes("CREATE POLICY")) ?? "";
    expect(bloque.match(/IF NOT EXISTS \( SELECT 1 FROM pg_policies/g)).toHaveLength(3);
  });

  it("claimmix_app lee, inserta y actualiza, y no borra, sólo si el rol existe", () => {
    const bloque = sentencias.find((s) => s.includes("REVOKE")) ?? "";
    expect(bloque).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app'\)/);
    expect(bloque).toMatch(/GRANT SELECT, INSERT, UPDATE ON public\.case_plan_pasos TO claimmix_app/);
    expect(bloque).toMatch(/REVOKE DELETE, TRUNCATE ON public\.case_plan_pasos FROM claimmix_app/);
    expect(bloque).not.toMatch(/GRANT[^;]*DELETE/);
  });

  it("coincide con la lista que sostienen create-app-role y pnpm permisos", () => {
    expect(PERMISOS_QUITADOS.case_plan_pasos).toEqual(["DELETE"]);
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

  it("no crea índices ni triggers ni siembra o toca datos", () => {
    expect(plano).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b|\bCONCURRENTLY\b|\bCREATE\s+TRIGGER\b/i);
    expect(plano).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|TRUNCATE\s+(TABLE\s+)?public|COPY)\b/i);
  });

  it("ningún COMMENT lleva guiones dobles dentro de la cadena", () => {
    const comentarios = CRUDO.split(/\r?\n/).filter((l) => /^\s+'/.test(l) || /^COMMENT ON/.test(l));
    expect(comentarios.length).toBeGreaterThan(0);
    for (const l of comentarios) expect(l).not.toContain("--");
  });
});
