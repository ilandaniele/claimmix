/**
 * `completadoConfirmado` (P6): la completitud automática de `/metricas` sólo
 * cuenta lo que confirmó una persona, o lo que ya se mandó al Core — nunca el
 * `listo` legado.
 *
 * Copia el arnés de `metricas-la-cuenta-de-verdad.test.ts` en vez de
 * importarlo: P4 edita ese archivo.
 */

vi.mock("server-only", () => ({}));

const { mockVarias } = vi.hoisted(() => ({ mockVarias: vi.fn() }));

vi.mock("@/data/scope", () => ({
  enTenantVarias: mockVarias,
  enTenant: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTenantKpis } from "@/server/metrics/kpis";
import { completadoConfirmado } from "@/server/cases/listo-confirmado";

const CTX = { tenantId: "10000000-0000-0000-0000-000000000001" };
const SIN_USO = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 };

beforeEach(() => mockVarias.mockReset());

describe("completadoConfirmado — el SQL que arma", () => {
  const dialecto = new PgDialect();
  const { sql, params } = dialecto.sqlToQuery(completadoConfirmado);

  it("cuenta enviado_a_core y listo_para_core confirmado, contra la auditoría", () => {
    expect(sql).toContain("enviado_a_core");
    expect(sql).toContain("listo_para_core");
    expect(sql).toContain("agent_runs");
    expect(params).toContain("case.ready_confirmed");
  });

  it("nunca cuenta el listo legado", () => {
    expect(sql).not.toMatch(/'listo'/);
  });
});

describe("getTenantKpis — el lote sigue en nueve consultas", () => {
  /*
   * Un cliente que acepta cualquier cadena y se devuelve a sí mismo: alcanza
   * para ejecutar el armador y contar cuántas consultas mete en el lote, sin
   * base. Mismo truco que en metricas-la-cuenta-de-verdad.test.ts.
   */
  const cadena: unknown = new Proxy(() => cadena, {
    get: () => cadena,
    apply: () => cadena,
  });
  const consultasDelLote = () =>
    (mockVarias.mock.calls[0]![1] as (db: unknown) => unknown[])(cadena).length;

  it("cambiar cómo se cuenta listo no agrega consultas al lote", async () => {
    mockVarias.mockImplementation(async () => [
      [{ total: 0, listo: 0, cerrados: 0, minutos: 0 }],
      [],
      [],
      [{ n: 0 }],
      [],
      [SIN_USO],
      [SIN_USO],
      [],
      [],
    ]);

    await getTenantKpis(CTX);

    expect(mockVarias).toHaveBeenCalledTimes(1);
    expect(consultasDelLote()).toBe(9);
  });
});
