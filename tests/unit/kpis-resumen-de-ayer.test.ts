/**
 * El resumen de ayer del lote de `getTenantKpis`.
 *
 * Sigue el mismo patrón que `metricas-la-cuenta-de-verdad.test.ts`: el mock de
 * `enTenantVarias` no ejecuta el armador para resolver sus datos —eso lo hace
 * cada test a mano, con un cliente falso—, así que acá se prueban dos cosas
 * por separado: cuántas consultas entran en el lote según `opts`, y el SQL
 * exacto que arma `consultaDeAyer` a través de ese mismo armador.
 */

vi.mock("server-only", () => ({}));

const { mockVarias } = vi.hoisted(() => ({ mockVarias: vi.fn() }));

vi.mock("@/data/scope", () => ({
  enTenantVarias: mockVarias,
  enTenant: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { getTenantKpis, type ResumenDeAyer } from "@/server/metrics/kpis";

const CTX = { tenantId: "10000000-0000-0000-0000-000000000001" };
const SIN_USO = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 };

/** Las nueve filas fijas del lote, más lo que cada test agregue al final. */
function filasDelLote(extra: unknown[] = []) {
  return [
    [{ total: 0, listo: 0, respondidos: 0, minutos: 0 }],
    [],
    [],
    [{ n: 0 }],
    [],
    [SIN_USO],
    [SIN_USO],
    [],
    [],
    ...extra,
  ];
}

/*
 * Un cliente que acepta cualquier cadena y se devuelve a sí mismo: alcanza
 * para ejecutar el armador y contar cuántas consultas mete en el lote, sin
 * base ni SQL de verdad.
 */
const cadena: unknown = new Proxy(() => cadena, {
  get: () => cadena,
  apply: () => cadena,
});
const consultasDelLote = () =>
  (mockVarias.mock.calls.at(-1)![1] as (db: unknown) => unknown[])(cadena).length;

beforeEach(() => mockVarias.mockReset());

describe("getTenantKpis — el resumen de ayer, según lo que se pida", () => {
  it("con serie y ayer, el lote lleva once consultas", async () => {
    mockVarias.mockResolvedValue(filasDelLote([[], []]));

    await getTenantKpis(CTX, { serie: "dia", ayer: true });

    expect(consultasDelLote()).toBe(11);
  });

  it("pedido solo, va como décima consulta y llega en `ayer`", async () => {
    const sentinela: ResumenDeAyer = {
      reclamos: 1,
      whatsapps: 2,
      mails: 3,
      escalados: 4,
      cerrados: 5,
      para_responder: 6,
      confirmacion_pendiente: 7,
    };
    mockVarias.mockResolvedValue(filasDelLote([[sentinela]]));

    const result = await getTenantKpis(CTX, { ayer: true });

    expect(consultasDelLote()).toBe(10);
    expect(result.ayer).toEqual(sentinela);
  });

  it("sin pedirlo, el lote sigue en nueve y la clave no aparece", async () => {
    mockVarias.mockResolvedValue(filasDelLote());

    const result = await getTenantKpis(CTX);

    expect(consultasDelLote()).toBe(9);
    expect("ayer" in result).toBe(false);
  });
});

describe("consultaDeAyer, a través del lote — la ventana y el SQL que arma", () => {
  afterEach(() => vi.useRealTimers());

  it("mide el día de ayer en horario argentino, sin canales simulados", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    mockVarias.mockResolvedValue(filasDelLote([[]]));

    await getTenantKpis(CTX, { ayer: true });

    const armador = mockVarias.mock.calls.at(-1)![1] as (
      db: unknown
    ) => { toSQL(): { sql: string; params: unknown[] } }[];
    const { sql, params } = armador(new QueryBuilder() as never).at(-1)!.toSQL();

    expect(params).toContain("2026-09-14T03:00:00.000Z");
    expect(params).toContain("2026-09-15T03:00:00.000Z");
    expect(sql).toContain(`"cases"."channel" in (`);
    expect(sql).toContain(`"para_responder_desde" is not null`);
    expect(sql).not.toMatch(/_sim/);
    expect(params.filter((p) => String(p).endsWith("_sim"))).toEqual([]);
  });
});
