/**
 * La 0050 se aplica a mano, en tres bases, y puede correr más de una vez. Trae el
 * registro de la base de cada inquilino (`tenant_bases`) y deja asegurado el
 * registro de migraciones que ya arma `migrate.mjs`. Lo que se vigila: que sea
 * aditiva e idempotente, que `claimmix_app` no tenga nada en ninguna de las dos,
 * que el registro conserve la forma de `migrate.mjs` (no la pisa ni la siembra) y
 * que el esquema de Drizzle diga lo mismo que el SQL.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";
import { PERMISOS_QUITADOS } from "../../scripts/lib/permisos-quitados.mjs";
import { schemaMigrations, tenantBases } from "@/lib/db/schema";

const CARPETA = join(process.cwd(), "neon/migrations");
const ARCHIVO = "0050_tenant_bases.sql";
const CRUDO = readFileSync(join(CARPETA, ARCHIVO), "utf8");
const SQL = CRUDO.split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const PLANO = SQL.replace(/\s+/g, " ");

/** Los nombres de columna que declara el CREATE TABLE de `tabla`. */
function columnasDelSql(tabla: string): string[] {
  const desde = SQL.indexOf(`CREATE TABLE IF NOT EXISTS public.${tabla} (`);
  const cuerpo = SQL.slice(desde, SQL.indexOf("\n);", desde));
  return cuerpo
    .split("\n")
    .map((l) => /^\s{2}(\w+) /.exec(l)?.[1])
    .filter((c): c is string => c !== undefined);
}

describe("migración 0050: tenant_bases", () => {
  it("es la única con el número 0050, y viene justo después de la 0049", () => {
    const archivos = readdirSync(CARPETA).filter((f) => f.endsWith(".sql"));

    expect(archivos.filter((f) => f.startsWith("0050_"))).toEqual([ARCHIVO]);
    expect(archivos.some((f) => f.startsWith("0049_"))).toBe(true);
  });

  it("nombra las tres bases en el orden en que se aplica", () => {
    const orden = ["ep-wispy-flower", "ep-proud-resonance", "STAGING_DATABASE_URL"].map((b) => CRUDO.indexOf(b));

    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
  });

  it("trae escrita la vuelta atrás y avisa que el código no tolera que la tabla falte", () => {
    expect(CRUDO).toContain("--   DROP TABLE IF EXISTS public.tenant_bases;");
    expect(CRUDO).toContain("--   node scripts/migrate.mjs --env <VAR> --forget 0050");
    expect(CRUDO).toContain("42P01");
  });

  it("es aditiva e idempotente: sólo CREATE IF NOT EXISTS, RLS, política y permisos", () => {
    const sentencias = splitSqlStatements(SQL).map((s: string) => s.replace(/\s+/g, " ").trim());

    expect(sentencias.map((s: string) => s.split(" ").slice(0, 2).join(" "))).toEqual([
      "CREATE TABLE",
      "CREATE INDEX",
      "ALTER TABLE",
      "ALTER TABLE",
      "DO $$",
      "CREATE TABLE",
      "REVOKE ALL",
      "DO $$",
    ]);
    expect(PLANO).not.toContain("CONCURRENTLY");
    expect(PLANO).not.toContain("DROP ");
    expect(PLANO).not.toMatch(/\b(INSERT|UPDATE|DELETE FROM|TRUNCATE)\b/);
    expect(PLANO.match(/CREATE (TABLE|INDEX) IF NOT EXISTS/g)).toHaveLength(3);
  });

  it("tenant_bases: un estado de los cuatro, la clave es el inquilino y se va con él", () => {
    expect(PLANO).toContain("tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE");
    expect(PLANO).toContain("estado text NOT NULL CHECK (estado IN ('creando', 'lista', 'fallida', 'borrada'))");
    expect(PLANO).toContain("version_migracion integer NOT NULL DEFAULT 0");
    expect(PLANO).toContain("intentos integer NOT NULL DEFAULT 0");
    expect(PLANO).toContain("creada_at timestamptz NOT NULL DEFAULT now()");
    expect(PLANO).toContain("ON public.tenant_bases (estado, tomada_at)");
  });

  it("tenant_bases: RLS forzada y una política que no deja pasar a nadie (la ve el rol dueño)", () => {
    expect(PLANO).toContain("ALTER TABLE public.tenant_bases ENABLE ROW LEVEL SECURITY");
    expect(PLANO).toContain("ALTER TABLE public.tenant_bases FORCE ROW LEVEL SECURITY");
    expect(PLANO).toContain("CREATE POLICY claimmix_solo_dueno ON public.tenant_bases USING (false) WITH CHECK (false)");
  });

  it("schema_migrations conserva la forma que crea migrate.mjs, y no se siembra", () => {
    const migrate = readFileSync(join(process.cwd(), "scripts/migrate.mjs"), "utf8");
    const delRunner = /create table if not exists schema_migrations \(([\s\S]*?)\)\s*`/.exec(migrate)?.[1] ?? "";
    const columnasDelRunner = delRunner
      .split("\n")
      .map((l) => /^\s*(\w+)\s+\w+/.exec(l)?.[1])
      .filter((c): c is string => c !== undefined);

    expect(columnasDelRunner).toEqual(["version", "filename", "checksum", "applied_at", "applied_by"]);
    expect(columnasDelSql("schema_migrations")).toEqual(columnasDelRunner);
    expect(PLANO).toContain("version text PRIMARY KEY");
    expect(PLANO).not.toContain("generate_series");
  });

  it("ninguna de las dos le queda a PUBLIC ni a claimmix_app, y sin el rol sólo avisa", () => {
    expect(PLANO).toContain("REVOKE ALL ON TABLE public.tenant_bases, public.schema_migrations FROM PUBLIC");
    expect(PLANO).toContain("rolname = 'claimmix_app'");
    expect(PLANO).toContain("REVOKE ALL ON TABLE public.tenant_bases, public.schema_migrations FROM claimmix_app");
    expect(PLANO).toContain("RAISE NOTICE");
  });

  it("pnpm permisos exige que el rol no tenga nada en ninguna de las dos", () => {
    const todo = ["SELECT", "INSERT", "UPDATE", "DELETE"];

    expect(PERMISOS_QUITADOS.tenant_bases).toEqual(todo);
    expect(PERMISOS_QUITADOS.schema_migrations).toEqual(todo);
  });

  it("el esquema de Drizzle dice lo mismo que el SQL", () => {
    expect(Object.keys(getTableColumns(tenantBases))).toEqual(columnasDelSql("tenant_bases"));
    expect(Object.keys(getTableColumns(schemaMigrations))).toEqual(columnasDelSql("schema_migrations"));
  });
});
