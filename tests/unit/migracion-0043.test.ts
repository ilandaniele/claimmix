/**
 * La 0043 se aplica a mano, en tres bases, y puede correr más de una vez: cada
 * sentencia tiene que poder repetirse sin error y ninguna puede sembrar datos.
 * `asistente_turnos` es privada de quien pregunta (usuario Y inquilino);
 * `case_desvios` la escribe el barrido y la app sólo la lee.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EVENTOS_DE_TRAYECTO } from "@/core/metricas/transiciones";
import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";
import { PERMISOS_QUITADOS } from "../../scripts/lib/permisos-quitados.mjs";

const SQL = readFileSync(join(process.cwd(), "neon/migrations/0043_asistente_y_desvios.sql"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const sentencias: string[] = splitSqlStatements(SQL).map((s: string) => s.replace(/\s+/g, " ").trim());
const plano = sentencias.join(";\n");

describe("migración 0043", () => {
  it("claimmix_current_user_id lee el contexto igual que el del inquilino", () => {
    expect(plano).toMatch(/CREATE OR REPLACE FUNCTION public\.claimmix_current_user_id\(\) RETURNS uuid/);
    expect(plano).toMatch(/NULLIF\(current_setting\('claimmix\.user_id', true\), ''\)::uuid/);
  });

  it("asistente_turnos: un turno es de un usuario y de un caso, y se va con ellos", () => {
    expect(plano).toMatch(/CREATE TABLE IF NOT EXISTS public\.asistente_turnos/);
    expect(plano).toMatch(/user_id uuid NOT NULL REFERENCES public\.users\(id\) ON DELETE CASCADE/);
    expect(plano).toMatch(/case_id uuid NOT NULL REFERENCES public\.cases\(id\) ON DELETE CASCADE/);
    expect(plano).toMatch(/rol text NOT NULL CHECK \(rol IN \('user', 'assistant'\)\)/);
  });

  it("asistente_turnos: la política de lectura pide inquilino Y usuario", () => {
    expect(plano).toMatch(
      /CREATE POLICY claimmix_tenant_isolation_select ON public\.asistente_turnos FOR SELECT USING \( public\.claimmix_tenant_matches\(tenant_id\) AND user_id = public\.claimmix_current_user_id\(\) \)/
    );
  });

  it("asistente_turnos: sólo se inserta un turno propio sobre un caso del mismo inquilino", () => {
    const insert = sentencias.find((s) => s.includes("asistente_turnos FOR INSERT")) ?? "";
    expect(insert).toMatch(/public\.claimmix_tenant_matches\(tenant_id\)/);
    expect(insert).toMatch(/user_id = public\.claimmix_current_user_id\(\)/);
    expect(insert).toMatch(/c\.id = asistente_turnos\.case_id AND c\.tenant_id = asistente_turnos\.tenant_id/);
  });

  it("case_desvios: la clave primaria es caso, regla y ancla", () => {
    expect(plano).toMatch(/CREATE TABLE IF NOT EXISTS public\.case_desvios/);
    expect(plano).toMatch(/PRIMARY KEY \(case_id, regla, ancla\)/);
  });

  it("case_desvios: sólo tiene política de lectura, y las reglas no se fijan con un CHECK", () => {
    const bloque = sentencias.find((s) => s.includes("ON public.case_desvios FOR")) ?? "";
    expect(bloque.match(/ON public\.case_desvios FOR/g)).toHaveLength(1);
    expect(bloque).toMatch(/ON public\.case_desvios FOR SELECT USING \(public\.claimmix_tenant_matches\(tenant_id\)\)/);
    const tabla = sentencias.find((s) => s.startsWith("CREATE TABLE IF NOT EXISTS public.case_desvios")) ?? "";
    expect(tabla).not.toMatch(/CHECK/);
  });

  it("fuerza RLS en las dos tablas", () => {
    for (const t of ["asistente_turnos", "case_desvios"]) {
      expect(plano).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`));
      expect(plano).toMatch(new RegExp(`ALTER TABLE public\\.${t} FORCE ROW LEVEL SECURITY`));
    }
  });

  it("las políticas sólo se crean si no están", () => {
    const bloque = sentencias.find((s) => s.includes("CREATE POLICY")) ?? "";
    expect(bloque.match(/CREATE POLICY/g)).toHaveLength(3);
    expect(bloque.match(/IF NOT EXISTS \( SELECT 1 FROM pg_policies/g)).toHaveLength(3);
  });

  it("claimmix_app: los turnos se leen e insertan, los desvíos sólo se leen, y sólo si el rol existe", () => {
    const bloque = sentencias.find((s) => s.includes("REVOKE")) ?? "";
    expect(bloque).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app'\)/);
    expect(bloque).toMatch(/GRANT SELECT, INSERT ON public\.asistente_turnos TO claimmix_app/);
    expect(bloque).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON public\.asistente_turnos FROM claimmix_app/);
    expect(bloque).toMatch(/GRANT USAGE, SELECT ON SEQUENCE public\.asistente_turnos_id_seq TO claimmix_app/);
    expect(bloque).toMatch(/GRANT SELECT ON public\.case_desvios TO claimmix_app/);
    expect(bloque).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.case_desvios FROM claimmix_app/);
    expect(bloque).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)/);
  });

  it("coincide con la lista que sostienen create-app-role y pnpm permisos", () => {
    expect(PERMISOS_QUITADOS.asistente_turnos).toEqual(["UPDATE", "DELETE"]);
    expect(PERMISOS_QUITADOS.case_desvios).toEqual(["INSERT", "UPDATE", "DELETE"]);
  });

  it("el índice de audit_log es parcial y sólo sobre eventos del trayecto de un caso", () => {
    const indice = sentencias.find((s) => s.includes("idx_audit_log_trayecto")) ?? "";
    expect(indice).toMatch(/^CREATE INDEX IF NOT EXISTS idx_audit_log_trayecto ON public\.audit_log \(target_id, created_at\) WHERE target_type = 'case'/);
    expect(indice).not.toMatch(/CONCURRENTLY/);
    const lista = indice.slice(indice.indexOf("event_type IN ("));
    const eventos = [...lista.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
    // Es la lista que usan el tablero y la revisión: si difieren, la consulta no usa el índice.
    expect([...eventos].sort()).toEqual([...EVENTOS_DE_TRAYECTO].sort());
  });

  it("cada sentencia se puede repetir", () => {
    for (const s of sentencias) {
      const repetible =
        /^CREATE OR REPLACE FUNCTION /.test(s) ||
        /^CREATE TABLE IF NOT EXISTS /.test(s) ||
        /^CREATE INDEX IF NOT EXISTS /.test(s) ||
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
