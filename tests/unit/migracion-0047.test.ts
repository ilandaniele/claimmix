/**
 * La 0047 se aplica a mano, en tres bases, y puede correr más de una vez: la
 * sentencia tiene que poder repetirse sin error. Hace única la casilla de Gmail
 * entre todos los inquilinos, así que lo que se vigila es que siga siendo un
 * índice único sobre lower(email) (no sobre (tenant_id, email), que ya existía),
 * que no use CONCURRENTLY (el runner corre todo en una transacción) y que lleve
 * escrito el chequeo previo, que es lo que evita que falle en una base con
 * duplicados.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";

const CARPETA = join(process.cwd(), "neon/migrations");
const ARCHIVO = "0047_una_casilla_de_gmail_una_sola_aseguradora.sql";
const CRUDO = readFileSync(join(CARPETA, ARCHIVO), "utf8");
const SQL = CRUDO.split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const sentencias: string[] = splitSqlStatements(SQL).map((s: string) => s.replace(/\s+/g, " ").trim());

describe("migración 0047: una casilla de Gmail, una sola aseguradora", () => {
  it("es la única con el número 0047, y viene justo después de la 0046", () => {
    const numeros = readdirSync(CARPETA)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.slice(0, 4));

    expect(numeros.filter((n) => n === "0047")).toHaveLength(1);
    expect(numeros).toContain("0046");
  });

  it("es una sola sentencia: un índice único sobre lower(email), repetible", () => {
    expect(sentencias).toEqual([
      "CREATE UNIQUE INDEX IF NOT EXISTS gmail_accounts_email_unica ON public.gmail_accounts (lower(email))",
    ]);
  });

  it("no usa CONCURRENTLY: el runner corre el archivo entero en una transacción", () => {
    expect(SQL).not.toMatch(/CONCURRENTLY/i);
  });

  it("no borra ni cambia filas: los duplicados se resuelven a mano, antes", () => {
    expect(SQL).not.toMatch(/\b(DELETE|UPDATE|DROP|ALTER|TRUNCATE)\b/i);
  });

  it("lleva escrito el chequeo previo y la vuelta atrás", () => {
    expect(CRUDO).toMatch(/GROUP BY lower\(email\)\s*\r?\n--\s+HAVING count\(\*\) > 1/);
    expect(CRUDO).toContain("DROP INDEX IF EXISTS public.gmail_accounts_email_unica");
  });

  it("nombra las tres bases en el orden en que se aplica", () => {
    const orden = ["ep-wispy-flower", "ep-proud-resonance", "STAGING_DATABASE_URL"].map((b) => CRUDO.indexOf(b));

    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
  });
});
