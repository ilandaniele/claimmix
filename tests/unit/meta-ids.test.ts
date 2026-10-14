/**
 * Los ids de Meta (`@/lib/meta-ids`): un solo ancho por clase de id, el mismo que el CHECK
 * de la tabla donde se guarda. Si alguien cambia el SQL o la regex, este test avisa.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ID_DE_META, ID_DE_USUARIO_DE_META } from "@/lib/meta-ids";

const sql0051 = readFileSync(resolve(process.cwd(), "neon/migrations/0051_waba_propia.sql"), "utf8");

/** Lo que el SQL exige de una columna, escrito como regex de JS. */
const checkDe = (columna: string): string => {
  const linea = sql0051.split(/\r?\n/).find((l) => l.trim().startsWith(`${columna} text CHECK`));
  const patron = linea?.match(/~ '([^']+)'/)?.[1];
  if (!patron) throw new Error(`sin CHECK de ${columna} en la 0051`);
  return patron.replace("[0-9]", String.raw`\d`);
};

describe("ID_DE_META", () => {
  it("de 6 a 20 dígitos", () => {
    expect(ID_DE_META.test("12345")).toBe(false);
    expect(ID_DE_META.test("123456")).toBe(true);
    expect(ID_DE_META.test("1".repeat(20))).toBe(true);
    expect(ID_DE_META.test("1".repeat(21))).toBe(false);
    expect(ID_DE_META.test("12345a")).toBe(false);
    expect(ID_DE_META.test("123456\n")).toBe(false);
  });

  it("es el CHECK del negocio y de la WABA en la 0051", () => {
    expect(ID_DE_META.source).toBe(checkDe("business_id"));
    expect(ID_DE_META.source).toBe(checkDe("waba_id"));
  });
});

describe("ID_DE_USUARIO_DE_META", () => {
  it("de 1 a 30 dígitos", () => {
    expect(ID_DE_USUARIO_DE_META.test("")).toBe(false);
    expect(ID_DE_USUARIO_DE_META.test("1")).toBe(true);
    expect(ID_DE_USUARIO_DE_META.test("1".repeat(30))).toBe(true);
    expect(ID_DE_USUARIO_DE_META.test("1".repeat(31))).toBe(false);
    expect(ID_DE_USUARIO_DE_META.test("abc")).toBe(false);
  });

  it("es el CHECK de fb_user_id en la 0051", () => {
    expect(ID_DE_USUARIO_DE_META.source).toBe(checkDe("fb_user_id"));
  });
});
