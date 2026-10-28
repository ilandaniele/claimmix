/**
 * Las cuatro cubetas del cupo, como SQL (`@/server/billing/cuentas-sql`).
 *
 * La base está fuera: lo que se vigila es el texto de cada conteo. Tienen que ser
 * disjuntas (cada denuncia cae en una sola) y con los nombres de columna crudos,
 * porque las consultas que las usan leen `cases` sin alias.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PESO_EN_DECIMAS, type Cubeta } from "@/lib/billing/plans";
import { cuentasPorCubeta } from "@/server/billing/cuentas-sql";

const dialecto = new PgDialect();
const render = (c: Cubeta) => dialecto.sqlToQuery(cuentasPorCubeta[c]);

describe("cuentasPorCubeta", () => {
  it("tiene una entrada por cada cubeta que pesa en el cupo, ni más ni menos", () => {
    expect(Object.keys(cuentasPorCubeta).sort()).toEqual(Object.keys(PESO_EN_DECIMAS).sort());
  });

  it.each(Object.keys(PESO_EN_DECIMAS) as Cubeta[])("%s cuenta sólo denuncias, en un entero, sin parámetros", (cubeta) => {
    const { sql, params } = render(cubeta);

    expect(sql).toContain("count(*) filter (where is_claim is true and (");
    expect(sql.endsWith(")::int")).toBe(true);
    expect(params).toEqual([]);
  });

  it("whatsapp es el del número de Veltra: sin WABA propia", () => {
    expect(render("whatsapp").sql).toContain("channel = 'whatsapp' and not waba_propia");
  });

  it("whatsapp_propia es el mismo canal con WABA propia, y no el negado", () => {
    const { sql } = render("whatsapp_propia");

    expect(sql).toContain("channel = 'whatsapp' and waba_propia");
    expect(sql).not.toContain("not waba_propia");
  });

  it("email y web se distinguen sólo por el canal", () => {
    expect(render("email").sql).toContain("channel = 'email'");
    expect(render("web").sql).toContain("channel = 'web'");
    expect(render("email").sql).not.toContain("waba_propia");
    expect(render("web").sql).not.toContain("waba_propia");
  });

  it("las condiciones son todas distintas: ninguna denuncia se cuenta dos veces", () => {
    const textos = (Object.keys(cuentasPorCubeta) as Cubeta[]).map((c) => render(c).sql);

    expect(new Set(textos).size).toBe(textos.length);
  });

  // `statement` y `tenant-summary` leen de `cases` solo: con un alias o un join, `channel` se vuelve ambiguo.
  it("los nombres de columna van crudos, sin tabla ni alias", () => {
    for (const cubeta of Object.keys(cuentasPorCubeta) as Cubeta[]) {
      expect(render(cubeta).sql).not.toMatch(/"cases"|\bcases\./);
    }
  });
});
