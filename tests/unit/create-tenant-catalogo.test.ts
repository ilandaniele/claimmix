/**
 * `scripts/create-tenant.mjs` lleva una copia a mano del catálogo (es un script suelto,
 * sin acceso a `@/`). Esta prueba la ata a `PLAN_CATALOG`: si el catálogo cambia y el script
 * no, el alta por línea de comandos dejaría términos que ningún plan tiene.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN_CATALOG, PLANS } from "@/lib/billing/plans";

const texto = readFileSync(join(process.cwd(), "scripts", "create-tenant.mjs"), "utf8");
const bloque = /const CATALOG = \{([\s\S]*?)\n\};/.exec(texto)?.[1] ?? "";

const filas = new Map(
  [...bloque.matchAll(/^\s*(\w+): \{ fee: ([\d.]+), included: (\d+), overage: ([\d.]+), status: "(\w+)" \},?\r?$/gm)].map(
    (m) => [m[1], { fee: Number(m[2]), included: Number(m[3]), overage: Number(m[4]), status: m[5] }]
  )
);

describe("el catálogo de create-tenant.mjs", () => {
  it("tiene los mismos planes que el catálogo, ni uno más ni uno menos", () => {
    expect([...filas.keys()].sort()).toEqual([...PLANS].sort());
  });

  it.each(PLANS)("%s: cuota, unidades y excedente son los de PLAN_CATALOG", (plan) => {
    const catalogo = PLAN_CATALOG[plan];

    expect(filas.get(plan)).toMatchObject({
      fee: catalogo.monthly_fee_usd,
      included: catalogo.included_claims,
      overage: catalogo.overage_price_usd,
    });
  });

  it("sólo piloto queda en prueba; el resto nace activo", () => {
    for (const [plan, fila] of filas) expect(fila.status).toBe(plan === "piloto" ? "trial" : "active");
  });

  it("el uso del script nombra todos los planes", () => {
    for (const plan of PLANS) expect(texto).toContain(plan);
    expect(texto).toMatch(/--plan <s>\s+piloto \(default\) \| inicial \|/);
  });
});
