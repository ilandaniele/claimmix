/**
 * La 0053 se aplica a mano, en tres bases y en las de cliente, y puede correr más de
 * una vez. Trae `users.dado_de_baja_en`, la marca de la baja: aditiva, sin datos,
 * sin permisos nuevos, y el esquema de Drizzle la conoce.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { users } from "@/lib/db/schema/core";
import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";

const CARPETA = join(process.cwd(), "neon/migrations");
const ARCHIVO = "0053_baja_de_usuarios.sql";
const SQL = readFileSync(join(CARPETA, ARCHIVO), "utf8")
  .split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const sentencias: string[] = splitSqlStatements(SQL).map((s: string) => s.replace(/\s+/g, " ").trim());

describe("migración 0053: baja de usuarios", () => {
  it("es la única con el número 0053, y viene justo después de la 0052", () => {
    const archivos = readdirSync(CARPETA).filter((f) => f.endsWith(".sql"));

    expect(archivos.filter((f) => f.startsWith("0053_"))).toEqual([ARCHIVO]);
    expect(archivos.some((f) => f.startsWith("0052_"))).toBe(true);
  });

  it("sólo agrega la columna, nula y repetible: sin datos, sin GRANT, sin políticas", () => {
    expect(sentencias).toEqual(["ALTER TABLE public.users ADD COLUMN IF NOT EXISTS dado_de_baja_en timestamptz"]);
    expect(SQL).not.toMatch(/GRANT|POLICY|UPDATE|NOT NULL|DEFAULT/i);
  });

  it("el esquema de Drizzle la tiene con el mismo tipo", () => {
    const columna = getTableColumns(users).dado_de_baja_en;

    expect(columna.name).toBe("dado_de_baja_en");
    expect(columna.getSQLType()).toBe("timestamp with time zone");
    expect(columna.notNull).toBe(false);
  });
});
