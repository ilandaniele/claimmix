/**
 * La migración 0055 — el plan «inicial» y la marca de WABA propia por caso.
 *
 * Lo que importa es lo que NO hace: sin UPDATE ni backfill (los términos que cada
 * inquilino ya tiene guardados no se mueven), sin cambiar la firma de
 * claimmix_crear_inquilino (toma el DEFAULT de included_claims) y sin columna nueva en
 * billing_invoices (las facturas congeladas no se recalculan). Y que la cabecera diga cómo
 * aplicarla: el código nuevo sin la columna da 42703 en toda la ingesta.
 */

import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";
import { billingInvoices, cases, tenants } from "@/lib/db/schema/core";

const DIR = join(process.cwd(), "neon", "migrations");

const archivos = readdirSync(DIR).filter((f) => f.startsWith("0055_"));
const cruda = readFileSync(join(DIR, archivos[0]), "utf8");
const sinComentarios = cruda
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");
const sentencias: string[] = splitSqlStatements(sinComentarios).map((s: string) => s.replace(/\s+/g, " ").trim());

describe("migración 0055", () => {
  it("es el único archivo 0055 y sigue a la 0054", () => {
    expect(archivos).toHaveLength(1);
    expect(readdirSync(DIR).filter((f) => f.startsWith("0054_"))).toHaveLength(1);
  });

  it("son tres sentencias: el CHECK del plan, el default de las unidades y la columna", () => {
    expect(sentencias).toHaveLength(3);
    expect(sentencias[0]).toMatch(/^DO \$\$/);
    expect(sentencias[1]).toBe("ALTER TABLE public.tenants ALTER COLUMN included_claims SET DEFAULT 50");
    expect(sentencias[2]).toBe(
      "ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS waba_propia boolean NOT NULL DEFAULT false"
    );
  });

  it("el CHECK sólo se rehace si el vigente no nombra 'inicial', y lo busca por tabla y por nombre", () => {
    const [bloque] = sentencias;

    expect(bloque).toContain("pg_get_constraintdef(c.oid)");
    expect(bloque).toContain("c.conrelid = 'public.tenants'::regclass");
    expect(bloque).toContain("c.conname = 'tenants_plan_check'");
    expect(bloque).toMatch(/vigente NOT ILIKE '%''inicial''%'/);
    expect(bloque).toContain(
      "CHECK (plan IN ('piloto','inicial','operativo','profesional','corporativo','enterprise'))"
    );
  });

  it("conserva 'piloto': sigue siendo el plan de las altas automáticas en prueba", () => {
    expect(sentencias[0]).toContain("'piloto'");
  });

  it("no migra datos, ni toca la función de alta ni la tabla de facturas", () => {
    expect(sinComentarios).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b/i);
    expect(sinComentarios).not.toMatch(/ALTER COLUMN \w+ (SET DATA )?TYPE/i);
    expect(sinComentarios).not.toMatch(/CREATE (OR REPLACE )?FUNCTION|claimmix_crear_inquilino/i);
    expect(sinComentarios).not.toMatch(/billing_invoices/i);
    expect(sinComentarios).not.toMatch(/GRANT|POLICY|INDEX|TRIGGER/i);
  });

  it("la cabecera dice cómo aplicarla: a mano, en orden, y qué pasa si no", () => {
    expect(cruda).toContain("A MANO");
    expect(cruda).toContain("42703");
    expect(cruda).toContain("23514");
    expect(cruda).toContain("DROP COLUMN");
    expect(cruda).toContain("canal de casos");

    const orden = ["ep-wispy-flower", "ep-proud-resonance", "STAGING_DATABASE_URL", "migrar-bases.mjs --env prd"].map(
      (t) => cruda.indexOf(t)
    );
    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
  });

  it("el esquema declara cases.waba_propia: boolean, NOT NULL, false", () => {
    const col = getTableColumns(cases).waba_propia;

    expect(col.name).toBe("waba_propia");
    expect(col.getSQLType()).toBe("boolean");
    expect(col.notNull).toBe(true);
    expect(col.default).toBe(false);
  });

  it("el esquema declara 50 unidades por omisión, y las facturas no ganan columnas", () => {
    expect(getTableColumns(tenants).included_claims.default).toBe(50);
    expect(Object.keys(getTableColumns(billingInvoices))).not.toContain("waba_propia");
    expect(Object.keys(getTableColumns(billingInvoices))).not.toContain("units");
  });
});
