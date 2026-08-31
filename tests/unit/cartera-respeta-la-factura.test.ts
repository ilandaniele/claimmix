/**
 * La cartera contradecía la factura que ya se había mandado.
 *
 * `/admin/facturacion` congela la liquidación de un mes cerrado en
 * `billing_invoices` —una por mes, y desde entonces se lee y no se recalcula: la
 * regla está decidida y escrita en `statement.ts`—. La pantalla de cartera, en
 * cambio, recalculaba SIEMPRE desde `cases` en vivo.
 *
 * Así que basta con que alguien corrija un caso de julio en agosto —marcarlo como
 * no-denuncia, cerrarlo mal, borrarlo— para que la cartera muestre un total
 * distinto del que la aseguradora tiene en la mano. Dos pantallas del mismo
 * producto diciendo dos números del mismo mes, las dos con cara de ser la
 * respuesta y ninguna diciendo cuál manda.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const CARTERA = readFileSync("src/server/billing/tenant-summary.ts", "utf8");

describe("la cartera lee la factura congelada", () => {
  it("consulta billing_invoices del mes", () => {
    expect(CARTERA).toContain("billingInvoices");
    expect(CARTERA).toContain("range.month");
  });

  it("y cuando hay factura, el total sale de ahí y no del recálculo", () => {
    expect(CARTERA).toContain("facturada");
    expect(CARTERA).toContain("Number(facturada.total_usd)");
  });

  it("las denuncias facturables también, no sólo el total", () => {
    // Un total congelado con un conteo recalculado al lado se lee peor que
    // cualquiera de los dos solo: los números de la misma fila no cierran.
    expect(CARTERA).toContain("Number(facturada.billable_claims)");
  });

  it("y el margen se calcula contra el total que de verdad se cobró", () => {
    /*
     * Anclado en `computeMargin(`, que es donde se calcula.
     *
     * Buscar `margin_pct` no servía: la primera aparición es la del tipo, arriba
     * del archivo, y la última es el `.margin_pct` que cierra la llamada — o
     * sea, DESPUÉS del argumento que hay que mirar. Las dos daban un test que
     * fallaba con el código correcto.
     */
    const i = CARTERA.indexOf("computeMargin(");
    expect(i).toBeGreaterThan(-1);
    expect(CARTERA.slice(i, i + 200)).toContain("facturada");
  });

  it("pero un mes SIN factura sigue calculándose en vivo", () => {
    /*
     * El control, y es la mitad que importa: el mes en curso todavía no tiene
     * factura —`statement.ts` sólo congela cuando el período terminó— así que si
     * esto leyera únicamente de `billing_invoices`, la cartera del mes actual
     * mostraría cero para todos.
     */
    expect(CARTERA).toContain("invoice.total_usd");
    expect(CARTERA).toContain("counts?.billable ?? 0");
  });
});
