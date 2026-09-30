/**
 * La 0044 se aplica a mano, en tres bases, y puede correr más de una vez: cada
 * sentencia tiene que poder repetirse sin error y ninguna puede sembrar datos.
 * `formulario_web` no admite DELETE para la app: borrar la fila liberaría el
 * enlace sin rastro.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";

const SQL = readFileSync(join(process.cwd(), "neon/migrations/0044_formulario_web_y_ramos.sql"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const sentencias: string[] = splitSqlStatements(SQL).map((s: string) => s.replace(/\s+/g, " ").trim());
const plano = sentencias.join(";\n");

describe("migración 0044", () => {
  it("formulario_web: una fila por inquilino, slug único y de formato cerrado", () => {
    expect(plano).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.formulario_web \( tenant_id uuid PRIMARY KEY REFERENCES public\.tenants\(id\) ON DELETE CASCADE/
    );
    expect(plano).toMatch(/activo boolean NOT NULL DEFAULT false/);
    expect(plano).toMatch(/slug ~ '\^\[a-z0-9\]\[a-z0-9-\]\{2,38\}\[a-z0-9\]\$'/);
    expect(plano).toMatch(/slug !~ '\^\[0-9a-f\]\{8\}-'/);
    expect(plano).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_formulario_web_slug ON public\.formulario_web \(slug\)/);
  });

  it("tenant_claim_types: clave por inquilino, nombres en dos lenguas y topes", () => {
    expect(plano).toMatch(/CREATE TABLE IF NOT EXISTS public\.tenant_claim_types/);
    expect(plano).toMatch(/PRIMARY KEY \(tenant_id, clave\)/);
    expect(plano).toMatch(/clave ~ '\^\[a-z\]\[a-z0-9_\]\{1,39\}\$'/);
    expect(plano).toMatch(/nombre_es text NOT NULL/);
    expect(plano).toMatch(/nombre_en text NOT NULL/);
    expect(plano).toMatch(/documentos text\[\] NOT NULL DEFAULT '\{\}'/);
    expect(plano).toMatch(/datos text\[\] NOT NULL DEFAULT '\{\}'/);
    expect(plano).toMatch(/cardinality\(documentos\) <= 20/);
    expect(plano).toMatch(/cardinality\(datos\) <= 20/);
  });

  it("fuerza RLS en las dos tablas con las cuatro políticas cada una", () => {
    for (const t of ["formulario_web", "tenant_claim_types"]) {
      expect(plano).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`));
      expect(plano).toMatch(new RegExp(`ALTER TABLE public\\.${t} FORCE ROW LEVEL SECURITY`));
      for (const op of ["select", "insert", "update", "delete"]) {
        expect(plano).toMatch(new RegExp(`CREATE POLICY claimmix_tenant_isolation_${op} ON public\\.${t}`));
      }
    }
    expect(plano.match(/CREATE POLICY/g)).toHaveLength(8);
  });

  it("INSERT y UPDATE exigen el inquilino también al escribir", () => {
    expect(plano.match(/FOR INSERT WITH CHECK \(public\.claimmix_tenant_matches\(tenant_id\)\)/g)).toHaveLength(2);
    expect(plano.match(/FOR UPDATE USING \(public\.claimmix_tenant_matches\(tenant_id\)\) WITH CHECK \(public\.claimmix_tenant_matches\(tenant_id\)\)/g)).toHaveLength(2);
  });

  it("las políticas sólo se crean si no están", () => {
    const bloques = sentencias.filter((s) => s.includes("CREATE POLICY"));
    const creadas = bloques.reduce((n, b) => n + (b.match(/CREATE POLICY/g)?.length ?? 0), 0);
    const guardadas = bloques.reduce(
      (n, b) => n + (b.match(/IF NOT EXISTS \( SELECT 1 FROM pg_policies/g)?.length ?? 0),
      0
    );
    expect(guardadas).toBe(creadas);
  });

  it("claimmix_app no borra el formulario, sólo si el rol existe", () => {
    const bloque = sentencias.find((s) => s.includes("GRANT")) ?? "";
    expect(bloque).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app'\)/);
    expect(bloque).toMatch(/GRANT SELECT, INSERT, UPDATE ON public\.formulario_web TO claimmix_app/);
    expect(bloque).toMatch(/REVOKE DELETE, TRUNCATE ON public\.formulario_web FROM claimmix_app/);
    expect(bloque).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.tenant_claim_types TO claimmix_app/);
    expect(bloque).not.toMatch(/GRANT[^;]*DELETE ON public\.formulario_web/);
  });

  it("claim_type deja de ser lista cerrada: sólo se exige el formato", () => {
    expect(plano).toMatch(/cases_claim_type_formato CHECK \(claim_type IS NULL OR claim_type ~ '\^\[a-z\]\[a-z0-9_\]\{1,39\}\$'\)/);
    expect(plano).toMatch(
      /agent_custom_fields_claim_type_formato CHECK \(claim_type IS NULL OR claim_type ~ '\^\[a-z\]\[a-z0-9_\]\{1,39\}\$'\)/
    );
    const suelta = sentencias.find((s) => s.includes("DROP CONSTRAINT %I") && s.includes("choque")) ?? "";
    expect(suelta).toMatch(/pg_get_constraintdef\(c\.oid\) ILIKE '%claim_type%'/);
  });

  it("el CHECK de canal suma 'web' y sólo se recrea si el vigente no lo nombra", () => {
    const bloque = sentencias.find((s) => s.includes("cases_channel_check")) ?? "";
    expect(bloque).toMatch(/NOT ILIKE '%''web''%'/);
    expect(bloque).toMatch(/CHECK \(channel IN \('email_sim', 'email', 'whatsapp_sim', 'whatsapp', 'web'\)\)/);
  });

  it("cada sentencia se puede repetir", () => {
    for (const s of sentencias) {
      const repetible =
        /^CREATE TABLE IF NOT EXISTS /.test(s) ||
        /^CREATE UNIQUE INDEX IF NOT EXISTS /.test(s) ||
        /^DO \$\$ (BEGIN|DECLARE)/.test(s) ||
        /^ALTER TABLE \S+ (ENABLE|FORCE) ROW LEVEL SECURITY$/.test(s) ||
        /^COMMENT ON /.test(s);
      expect(repetible, s.slice(0, 80)).toBe(true);
    }
  });

  it("no siembra ni toca datos", () => {
    expect(plano).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|TRUNCATE\s+(TABLE\s+)?public|COPY)\b/i);
  });
});
