// @vitest-environment node
/**
 * Lo que /configuracion lee de `core_sync_settings` y cómo se reconoce la 0036
 * sin aplicar. La vista va al navegador del admin: si alguna vez trae el
 * secreto cifrado o el hash de la clave, queda en el HTML de la página.
 *
 * `QueryBuilder` arma la consulta sin conexión: no hay base de por medio.
 */

import { QueryBuilder } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { ClienteDatos } from "@/data/scope";
import { AppError } from "@/lib/errors";
import {
  codigoPg,
  consultaDeLaConfig,
  esFaltaDe0036,
  faltaLa0040,
  faltaLa0042,
  faltaLaMigracion,
  faltaLaMigracionConTabla,
  vistaDeLaConfig,
} from "@/server/core-sync/config";

const sinBase = new QueryBuilder() as unknown as ClienteDatos;

function armada(consulta: unknown) {
  const q = consulta as { toSQL(): { sql: string; params: unknown[] }; _: { selectedFields: Record<string, unknown> } };
  return { ...q.toSQL(), campos: Object.keys(q._.selectedFields) };
}

describe("vistaDeLaConfig", () => {
  const { sql: texto, params, campos } = armada(vistaDeLaConfig(sinBase));

  it("devuelve si hay secreto y clave, nunca cuáles son", () => {
    expect(campos.sort()).toEqual(
      ["api_key_prefix", "enabled", "tiene_clave", "tiene_secreto", "updated_at", "webhook_url"].sort()
    );
  });

  it("los booleanos salen de la consulta, sin traer las columnas", () => {
    expect(texto).toMatch(/"signing_secret_enc" is not null/);
    expect(texto).toMatch(/"api_key_hash" is not null/);
    expect(texto).not.toMatch(/"signing_secret_enc"\s*(,|from)/i);
    expect(texto).not.toMatch(/"api_key_hash"\s*(,|from)/i);
  });

  it("no filtra por inquilino a mano: la fila la elige RLS", () => {
    expect(texto).not.toMatch(/\bwhere\b/i);
    expect(params).toEqual([]);
  });
});

describe("consultaDeLaConfig", () => {
  it("trae sólo lo que usa la fábrica del cliente, y no el hash de la clave", () => {
    const { sql: texto, campos } = armada(consultaDeLaConfig(sinBase));
    expect(campos.sort()).toEqual(["enabled", "signing_secret_enc", "webhook_url"]);
    expect(texto).not.toContain("api_key_hash");
  });
});

describe("esFaltaDe0036", () => {
  it.each(["42P01", "42703"])("reconoce %s directo y envuelto en cause", (code) => {
    expect(esFaltaDe0036({ code })).toBe(true);
    expect(esFaltaDe0036(Object.assign(new Error("Failed query"), { cause: { code } }))).toBe(true);
  });

  it.each([
    ["otro código", { code: "23514" }],
    ["otro código envuelto", { cause: { code: "42501" } }],
    ["sin código", new Error("x")],
    ["null", null],
    ["undefined", undefined],
    ["string", "42P01"],
  ])("no confunde %s con la 0036", (_, e) => {
    expect(esFaltaDe0036(e)).toBe(false);
  });
});

describe("codigoPg", () => {
  it("lee el código directo o envuelto por drizzle en cause", () => {
    expect(codigoPg({ code: "23514" })).toBe("23514");
    expect(codigoPg(Object.assign(new Error("Failed query"), { cause: { code: "23514" } }))).toBe("23514");
    expect(codigoPg(new Error("x"))).toBeUndefined();
    expect(codigoPg(null)).toBeUndefined();
  });
});

describe("faltaLa0040", () => {
  it("una columna que falta es la migración pendiente; otro error sigue igual", () => {
    const sinColumna = Object.assign(new Error("Failed query"), { cause: { code: "42703" } });
    expect(() => faltaLa0040(sinColumna)).toThrow(expect.objectContaining({ code: "MIGRACION_PENDIENTE" }));
    expect(() => faltaLa0040(sinColumna)).toThrow(AppError);

    const otro = { code: "23514" };
    expect(() => faltaLa0040(otro)).toThrow(expect.objectContaining({ code: "23514" }));
  });
});

describe("faltaLa0042", () => {
  it.each(["42P01", "42703"])("%s es la migración pendiente y la nombra", (code) => {
    const falta = Object.assign(new Error("Failed query"), { cause: { code } });
    expect(() => faltaLa0042(falta)).toThrow(AppError);
    expect(() => faltaLa0042(falta)).toThrow("Falta aplicar la migración 0042.");
  });

  it("otro error sigue igual", () => {
    expect(() => faltaLa0042({ code: "23514" })).toThrow(expect.objectContaining({ code: "23514" }));
  });
});

describe("faltaLaMigracion", () => {
  it("nombra las migraciones que puede estar faltando", () => {
    const sinColumna = { code: "42703" };
    expect(() => faltaLaMigracion("0040", "0042")(sinColumna)).toThrow("Falta aplicar la migración 0040 o 0042.");
    expect(() => faltaLa0040(sinColumna)).toThrow("Falta aplicar la migración 0040.");
  });

  it("una migración que sólo agrega columnas no toma por pendiente una tabla que falta", () => {
    const sinTabla = { code: "42P01" };
    expect(() => faltaLaMigracion("0040")(sinTabla)).toThrow(expect.objectContaining({ code: "42P01" }));
    expect(() => faltaLaMigracionConTabla("0042")(sinTabla)).toThrow(AppError);
  });

  it("un error sin código sigue igual", () => {
    const raro = new Error("boom");
    expect(() => faltaLaMigracionConTabla("0042")(raro)).toThrow(raro);
  });

  it("otro error sigue igual", () => {
    const otro = { code: "23514" };
    expect(() => faltaLaMigracion("0042")(otro)).toThrow(expect.objectContaining({ code: "23514" }));
  });
});
