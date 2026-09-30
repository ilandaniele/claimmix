/**
 * La 0045 se aplica a mano, en tres bases, y puede correr más de una vez: cada
 * sentencia tiene que poder repetirse sin error y ninguna puede sembrar ni
 * borrar datos. `adjuntos_por_purgar` es la única cola que sobrevive al caso: si
 * la app pudiera reescribirla, una purga cancelada o vaciada no dejaría rastro.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";
import { PERMISOS_QUITADOS } from "../../scripts/lib/permisos-quitados.mjs";

const ARCHIVO = "0045_sso_y_purga_de_adjuntos.sql";
const SQL = readFileSync(join(process.cwd(), "neon/migrations", ARCHIVO), "utf8")
  .split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const sentencias: string[] = splitSqlStatements(SQL).map((s: string) => s.replace(/\s+/g, " ").trim());
const plano = sentencias.join(";\n");

const tabla = (nombre: string) =>
  sentencias.find((s) => new RegExp(`^CREATE TABLE IF NOT EXISTS public\\.${nombre} `).test(s)) ?? "";

describe("migración 0045", () => {
  it("lleva el prefijo 0045 y es la única con ese número", () => {
    const con0045 = readdirSync(join(process.cwd(), "neon/migrations")).filter((f) => f.startsWith("0045_"));
    expect(con0045).toEqual([ARCHIVO]);
  });

  it("sso_settings: una fila por inquilino, apagada y con el dominio en minúscula", () => {
    const t = tabla("sso_settings");
    expect(t).toMatch(/tenant_id uuid PRIMARY KEY REFERENCES public\.tenants\(id\) ON DELETE CASCADE/);
    expect(t).toMatch(/client_secret_cifrado text/);
    expect(t).toMatch(/activo boolean NOT NULL DEFAULT false/);
    expect(t).toMatch(/exigir boolean NOT NULL DEFAULT false/);
    expect(t).toMatch(/CHECK \(dominio = lower\(dominio\)\)/);
  });

  it("un dominio verificado es de un solo inquilino", () => {
    expect(plano).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_sso_settings_dominio_verificado ON public\.sso_settings \(dominio\) WHERE dominio_verificado_en IS NOT NULL/
    );
  });

  it("adjuntos_por_purgar: sin FK en tenant_id ni case_id y con el path NO único (la cola sólo se agrega)", () => {
    const t = tabla("adjuntos_por_purgar");
    expect(t).toMatch(/tenant_id uuid NOT NULL,/);
    expect(t).toMatch(/case_id uuid NOT NULL,/);
    expect(t).not.toMatch(/REFERENCES/);
    expect(t).toMatch(/storage_path text NOT NULL,/);
    expect(t).not.toMatch(/UNIQUE/);
    expect(t).toMatch(/intentos smallint NOT NULL DEFAULT 0/);
    expect(t).toMatch(/purgar_despues timestamptz,/);
  });

  it("la cola se recorre con un índice parcial de lo pendiente", () => {
    expect(plano).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_adjuntos_por_purgar_pendientes ON public\.adjuntos_por_purgar \(purgar_despues\) WHERE purgado_en IS NULL/
    );
  });

  it("el path y el momento de encolado tienen índice, para saber cuál es la fila más nueva", () => {
    expect(plano).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_adjuntos_por_purgar_path ON public\.adjuntos_por_purgar \(storage_path, encolado_en\)/
    );
    expect(plano).not.toMatch(/CREATE UNIQUE INDEX[^;]*adjuntos_por_purgar/);
  });

  it("idx_cases_closed_at es parcial y no usa CONCURRENTLY", () => {
    expect(plano).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_cases_closed_at ON public\.cases \(closed_at\) WHERE closed_at IS NOT NULL/
    );
    expect(plano).not.toMatch(/CONCURRENTLY/i);
  });

  it("fuerza RLS en las dos tablas con la política del inquilino", () => {
    for (const t of ["sso_settings", "adjuntos_por_purgar"]) {
      expect(plano).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`));
      expect(plano).toMatch(new RegExp(`ALTER TABLE public\\.${t} FORCE ROW LEVEL SECURITY`));
      expect(plano).toMatch(
        new RegExp(
          `CREATE POLICY claimmix_tenant_isolation ON public\\.${t} USING \\(public\\.claimmix_tenant_matches\\(tenant_id\\)\\) WITH CHECK \\(public\\.claimmix_tenant_matches\\(tenant_id\\)\\)`
        )
      );
    }
    expect(plano.match(/CREATE POLICY/g)).toHaveLength(2);
  });

  it("las políticas sólo se crean si no están", () => {
    const bloque = sentencias.find((s) => s.includes("CREATE POLICY")) ?? "";
    expect(bloque.match(/IF NOT EXISTS \( SELECT 1 FROM pg_policies/g)).toHaveLength(2);
  });

  it("claimmix_app sólo encola en adjuntos_por_purgar, y sólo si el rol existe", () => {
    const bloque = sentencias.find((s) => s.includes("REVOKE")) ?? "";
    expect(bloque).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'claimmix_app'\)/);
    expect(bloque).toMatch(/GRANT SELECT, INSERT ON public\.adjuntos_por_purgar TO claimmix_app/);
    expect(bloque).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON public\.adjuntos_por_purgar FROM claimmix_app/);
    expect(bloque).not.toMatch(/GRANT[^;]*adjuntos_por_purgar[^;]*(UPDATE|DELETE)/);
  });

  it("coincide con la lista que sostienen create-app-role y pnpm permisos", () => {
    expect(PERMISOS_QUITADOS.adjuntos_por_purgar).toEqual(["UPDATE", "DELETE"]);
    // La de sso_settings no quita nada: el admin del inquilino la configura desde /configuracion.
    expect(PERMISOS_QUITADOS).not.toHaveProperty("sso_settings");
  });

  it("cada sentencia se puede repetir", () => {
    for (const s of sentencias) {
      const repetible =
        /^CREATE TABLE IF NOT EXISTS /.test(s) ||
        /^CREATE (UNIQUE )?INDEX IF NOT EXISTS /.test(s) ||
        /^DO \$\$ BEGIN IF (NOT )?EXISTS /.test(s) ||
        /^ALTER TABLE \S+ (ENABLE|FORCE) ROW LEVEL SECURITY$/.test(s) ||
        /^COMMENT ON /.test(s);
      expect(repetible, s.slice(0, 80)).toBe(true);
    }
  });

  it("no siembra, no borra y no reescribe datos", () => {
    expect(plano).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|TRUNCATE\s+(TABLE\s+)?public|COPY|DROP\s+(TABLE|COLUMN|INDEX|POLICY|CONSTRAINT))\b/i
    );
  });

  it("no usa triggers ni SECURITY DEFINER", () => {
    expect(plano).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER|SECURITY\s+DEFINER/i);
  });
});
