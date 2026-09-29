/**
 * La 0036 se aplica a mano, en tres bases, y puede correr más de una vez: cada
 * sentencia tiene que poder repetirse sin error y ninguna puede sembrar datos.
 * La tabla guarda el secreto de firma y el hash de la clave de /api/v1, así
 * que RLS forzada y sin DELETE para `claimmix_app` no son opcionales.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";
import { PERMISOS_QUITADOS } from "../../scripts/lib/permisos-quitados.mjs";

const SQL = readFileSync(join(process.cwd(), "neon/migrations/0036_entrega_al_core.sql"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const sentencias: string[] = splitSqlStatements(SQL).map((s: string) => s.replace(/\s+/g, " ").trim());
const plano = sentencias.join(";\n");

describe("migración 0036", () => {
  it("fuerza RLS con la política de siempre en USING y WITH CHECK", () => {
    expect(plano).toMatch(/ALTER TABLE public\.core_sync_settings ENABLE ROW LEVEL SECURITY/);
    expect(plano).toMatch(/ALTER TABLE public\.core_sync_settings FORCE ROW LEVEL SECURITY/);
    expect(plano).toMatch(
      /CREATE POLICY claimmix_tenant_isolation ON public\.core_sync_settings USING \(public\.claimmix_tenant_matches\(tenant_id\)\) WITH CHECK \(public\.claimmix_tenant_matches\(tenant_id\)\)/
    );
  });

  it.each(["webhook_https", "api_key_hash_hex", "activo_completo"])("declara el CHECK %s", (nombre) => {
    expect(plano).toMatch(new RegExp(`ADD CONSTRAINT core_sync_settings_${nombre} CHECK`));
  });

  it("el CHECK activo_completo exige URL y secreto para prender", () => {
    expect(plano).toMatch(/CHECK \(NOT enabled OR \(webhook_url IS NOT NULL AND signing_secret_enc IS NOT NULL\)\)/);
  });

  it("quita DELETE a claimmix_app sólo si el rol existe", () => {
    const bloque = sentencias.find((s) => s.includes("REVOKE"));
    expect(bloque).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app'\)/);
    expect(bloque).toMatch(/REVOKE DELETE, TRUNCATE ON public\.core_sync_settings FROM claimmix_app/);
    expect(bloque).not.toMatch(/GRANT[^;]*DELETE/);
  });

  it("coincide con la lista que sostienen create-app-role y pnpm permisos", () => {
    expect(PERMISOS_QUITADOS.core_sync_settings).toEqual(["DELETE"]);
  });

  it("cada sentencia se puede repetir", () => {
    for (const s of sentencias) {
      const repetible =
        /^CREATE TABLE IF NOT EXISTS /.test(s) ||
        /^CREATE UNIQUE INDEX IF NOT EXISTS /.test(s) ||
        /^DO \$\$ BEGIN IF (NOT )?EXISTS /.test(s) ||
        /^ALTER TABLE \S+ (ENABLE|FORCE) ROW LEVEL SECURITY$/.test(s) ||
        /^DROP POLICY IF EXISTS /.test(s) ||
        (/^CREATE POLICY /.test(s) && plano.includes("DROP POLICY IF EXISTS claimmix_tenant_isolation ON public.core_sync_settings")) ||
        /^COMMENT ON /.test(s);
      expect(repetible, s.slice(0, 80)).toBe(true);
    }
  });

  it("los CHECK sólo se agregan si no están", () => {
    const bloque = sentencias.find((s) => s.includes("ADD CONSTRAINT")) ?? "";
    expect(bloque.match(/ADD CONSTRAINT/g)).toHaveLength(3);
    expect(bloque.match(/IF NOT EXISTS \( SELECT 1 FROM pg_constraint/g)).toHaveLength(3);
  });

  it("no siembra ni toca datos", () => {
    expect(plano).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|TRUNCATE\s+(TABLE\s+)?public|COPY)\b/i);
  });
});
