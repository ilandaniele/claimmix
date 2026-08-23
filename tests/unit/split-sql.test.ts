/**
 * Partir mal un archivo SQL aplica media migración.
 *
 * El partidor existe porque el SQL sobre HTTPS de Neon acepta una sentencia por
 * pedido, así que desde una red sin el puerto 5432 el archivo hay que cortarlo.
 * Cortar por `;` a secas alcanza hasta el primer archivo con un bloque
 * `DO $$ ... $$` —la migración 0010 tiene uno— donde los puntos y comas de
 * adentro parten el cuerpo al medio: la primera mitad se ejecuta, falla por
 * sintaxis, y la migración queda a medio aplicar con el ledger diciendo otra
 * cosa.
 *
 * Estos tests son los casos donde un partidor ingenuo se equivoca.
 */

import { describe, it, expect } from "vitest";
import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";

describe("splitSqlStatements", () => {
  it("corta las sentencias simples", () => {
    const out = splitSqlStatements("create table a (id int);\ncreate index i on a (id);");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("create table a");
    expect(out[1]).toContain("create index i");
  });

  it("no corta adentro de un bloque con comillas de dólar", () => {
    const sql = [
      "alter table t add column c int;",
      "DO $$",
      "BEGIN",
      "  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'x') THEN",
      "    ALTER TABLE t ADD CONSTRAINT x CHECK (c >= 0);",
      "  END IF;",
      "END $$;",
      "create index idx on t (c);",
    ].join("\n");

    const out = splitSqlStatements(sql);

    expect(out).toHaveLength(3);
    // El bloque entero es UNA sentencia: si se hubiera partido, los tres
    // puntos y comas de adentro darían cinco pedazos que no compilan solos.
    expect(out[1]).toContain("BEGIN");
    expect(out[1]).toContain("END IF");
    expect(out[1]!.endsWith("END $$")).toBe(true);
  });

  it("respeta las etiquetas con nombre", () => {
    const sql = "DO $migracion$ BEGIN PERFORM 1; END $migracion$;\nselect 1;";
    const out = splitSqlStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("PERFORM 1;");
  });

  it("no corta adentro de una constante de texto", () => {
    const out = splitSqlStatements("insert into t (s) values ('a;b');\nselect 1;");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("'a;b'");
  });

  it("entiende la comilla escapada de Postgres", () => {
    // 'no'';b' es UN texto que contiene una comilla y un punto y coma.
    const out = splitSqlStatements("insert into t (s) values ('no'';b');\nselect 2;");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("'no'';b'");
  });

  it("no corta adentro de un comentario", () => {
    const out = splitSqlStatements("select 1; -- esto; no; corta\nselect 2;");
    expect(out).toHaveLength(2);
  });

  it("no corta adentro de un comentario de bloque anidado", () => {
    const out = splitSqlStatements("select 1; /* uno /* dos ; */ tres ; */ select 2;");
    expect(out).toHaveLength(2);
  });

  it("descarta lo que es sólo comentario o espacio", () => {
    // El encabezado de cualquier migración de este repo: veinte líneas de
    // comentario antes de la primera sentencia. Mandarlas al servidor como
    // sentencia da error de sintaxis.
    const out = splitSqlStatements("-- por qué existe esto\n-- y qué arregla\n\ncreate table a (id int);\n");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("create table a");
  });

  it("acepta la última sentencia sin punto y coma final", () => {
    const out = splitSqlStatements("select 1;\nselect 2");
    expect(out).toHaveLength(2);
    expect(out[1]).toBe("select 2");
  });

  it("un archivo vacío no produce sentencias", () => {
    expect(splitSqlStatements("\n\n-- nada\n")).toHaveLength(0);
  });
});
