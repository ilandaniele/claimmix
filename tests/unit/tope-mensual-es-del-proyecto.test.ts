/**
 * El tope mensual de gasto es del PROYECTO, no de cada aseguradora.
 *
 * La consulta que lo calcula corría dentro de `enTenant`, o sea acotada por RLS
 * al inquilino que estaba pidiendo. Con eso, el tope de US$200 pasaba a ser
 * US$200 POR aseguradora: con cuatro inquilinos activos gastando 199 cada uno,
 * el gasto real es 796, ninguno de los cuatro se pasa de su propia cuenta, y los
 * cuatro siguen extrayendo. El techo declarado es 200 y la tarjeta paga 796.
 *
 * Lo delataba el propio código: la consulta lleva `ne(tenant_id, demoTenantId)`
 * para descontar la demo, y descontar la demo sólo tiene sentido si la suma
 * cruza inquilinos. Acotada por RLS, esa cláusula no podía hacer nada.
 *
 * Y `/api/health` ya sumaba sin `enTenant`, así que el número que se mostraba y
 * el que gobernaba el corte no eran el mismo.
 *
 * ── Cómo distingue este test ────────────────────────────────────────────────
 *
 * Dándole dos bases distintas: la que llega por `enTenant` devuelve lo de UN
 * inquilino (199, por debajo del tope) y la cruda devuelve lo del proyecto (796,
 * por encima). Si la consulta vuelve a meterse dentro de `enTenant`, ve 199 y
 * deja pasar — y el test se pone rojo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** Lo que ve una consulta acotada por inquilino. */
const GASTO_DE_UN_INQUILINO = 199;
/** Lo que ve una consulta que cruza inquilinos. */
const GASTO_DEL_PROYECTO = 796;

const porInquilino = { usada: false };

vi.mock("server-only", () => ({}));

function baseQueDevuelve(total: number, marcar?: () => void) {
  const filas = [{ total }, { total: 0 }, { total: 0 }, { total: 0 }];
  let n = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => {
          marcar?.();
          return Promise.resolve([filas[n++] ?? { total: 0 }]);
        },
      }),
    }),
  };
}

vi.mock("@/data/scope", () => ({
  // Una base DISTINTA de la cruda: la acotada al inquilino.
  enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
    Promise.resolve(
      armar(
        baseQueDevuelve(GASTO_DE_UN_INQUILINO, () => {
          porInquilino.usada = true;
        })
      )
    ),
  enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
    Promise.all(armar(baseQueDevuelve(GASTO_DE_UN_INQUILINO))),
}));

vi.mock("@/lib/db", () => ({
  db: baseQueDevuelve(GASTO_DEL_PROYECTO),
  tables: {
    aiUsage: {
      tenant_id: { name: "tenant_id" },
      user_id: { name: "user_id" },
      created_at: { name: "created_at" },
      cost_usd: { name: "cost_usd" },
      prompt_tokens: { name: "prompt_tokens" },
      completion_tokens: { name: "completion_tokens" },
    },
  },
}));

const TENANT = "10000000-0000-0000-0000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  porInquilino.usada = false;
  delete process.env.MONTHLY_BUDGET_USD;
  delete process.env.DEMO_TENANT_ID;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("el tope mensual mira el gasto de TODO el proyecto", () => {
  it("corta cuando la suma del proyecto se pasa, aunque el inquilino no", async () => {
    // 199 por inquilino está por debajo de 200; 796 en total, no.
    const { checkBudget } = await import("@/server/ai/budget");

    const r = await checkBudget(TENANT);

    expect(r.exceeded).toBe(true);
  });

  it("y no corta cuando el proyecto entero está por debajo", async () => {
    /*
     * El control. Un arreglo que cortara siempre —o que leyera el número
     * equivocado en la otra dirección— pasaría el test de arriba y dejaría el
     * producto sin extraer nada.
     */
    process.env.MONTHLY_BUDGET_USD = "1000";
    const { checkBudget } = await import("@/server/ai/budget");

    const r = await checkBudget(TENANT);

    expect(r.exceeded).toBe(false);
  });
});
