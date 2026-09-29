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
import { codigoPg, consultaDeLaConfig, esFaltaDe0036, vistaDeLaConfig } from "@/server/core-sync/config";

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
