/**
 * `approvedExamplesForTenant` alimenta el fine-tuning, no el prompt few-shot
 * (ver `deEjemplos`, que es donde se tacha). Con datos de personas reales no
 * se entrena un modelo, así que acá el filtro es más duro: sólo casos
 * simulados.
 *
 * Sin base: se captura la consulta que arma la función, sin ejecutarla, y se
 * lee el SQL que produce Drizzle.
 */

const { mockTenant } = vi.hoisted(() => ({ mockTenant: vi.fn() }));

vi.mock("@/data/scope", () => ({
  enTenant: mockTenant,
}));

import { describe, expect, it, vi } from "vitest";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { approvedExamplesForTenant } from "@/server/training/dataset";

describe("approvedExamplesForTenant — el SQL que arma", () => {
  it("cruza con cases y filtra por email_sim/whatsapp_sim", async () => {
    let capturada: { toSQL(): { sql: string; params: unknown[] } } | undefined;
    mockTenant.mockImplementation(
      async (_ctx: unknown, armar: (db: unknown) => unknown) => {
        capturada = armar(new QueryBuilder()) as typeof capturada;
        return [];
      }
    );

    await approvedExamplesForTenant("10000000-0000-0000-0000-000000000001");

    const { sql, params } = capturada!.toSQL();
    expect(sql).toMatch(/inner join "cases"/i);
    expect(sql).toMatch(/"cases"\."channel" in \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(["email_sim", "whatsapp_sim"]));
  });
});
