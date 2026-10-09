/**
 * Con una base por inquilino, el gasto de IA queda en dos libros.
 *
 * Los topes por inquilino leen `ai_usage` en la base del inquilino, pero el tope
 * del proyecto lo suma el dueño y el dueño sólo ve control. Si `recordUsage`
 * escribiera únicamente en la base del inquilino, el tope de US$200 dejaría de
 * ver el gasto de todos: cada cliente gastaría sin que la suma global se
 * enterara. Por eso, con `BASE_POR_CLIENTE=1`, la misma fila se copia en control
 * dentro de `after()`: no suma latencia a la llamada.
 *
 * Con la bandera apagada hay una sola base y la función hace lo de siempre.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Libro = "inquilino" | "control";

const h = vi.hoisted(() => ({
  inserts: [] as Array<{ libro: Libro; ctx: unknown; valores: Record<string, unknown> }>,
  // Lo que cada libro tira en el próximo insert, en orden.
  fallos: { inquilino: [] as unknown[], control: [] as unknown[] },
  tareas: [] as Array<() => unknown>,
  afuera: { valor: false },
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // Igual que Next: la tarea corre después. Fuera de un pedido, tira.
  after: (tarea: () => unknown) => {
    if (h.afuera.valor) throw new Error("`after` was called outside a request scope");
    h.tareas.push(tarea);
  },
}));

vi.mock("@/lib/db", () => ({ db: {}, tables: { aiUsage: "ai_usage" } }));

vi.mock("@/data/scope", () => {
  const sobre =
    (libro: Libro) =>
    async (ctx: unknown, armar: (db: unknown) => unknown) => {
      const db = {
        insert: () => ({
          values: async (valores: Record<string, unknown>) => {
            const falla = h.fallos[libro].shift();
            if (falla) throw falla;
            h.inserts.push({ libro, ctx, valores });
          },
        }),
      };
      return armar(db);
    };
  return { enTenant: sobre("inquilino"), enControl: sobre("control") };
});

vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: h.error },
}));

import { recordUsage, registrarConsumoDelModelo } from "@/server/ai/budget";

const INQUILINO = "10000000-0000-0000-0000-000000000001";
const CENTINELA = "00000000-0000-0000-0000-000000000000";
const USUARIO = "30000000-0000-0000-0000-000000000003";
const SAVED = { ...process.env };

/** Corre lo que `after()` dejó para después, como lo hace Next al contestar. */
async function correrLoPendiente() {
  const pendientes = h.tareas.splice(0);
  for (const tarea of pendientes) await tarea();
}

beforeEach(() => {
  h.inserts.length = 0;
  h.fallos.inquilino.length = 0;
  h.fallos.control.length = 0;
  h.tareas.length = 0;
  h.afuera.valor = false;
  h.error.mockClear();
  h.warn.mockClear();
  delete process.env.BASE_POR_CLIENTE;
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe("recordUsage con la bandera apagada", () => {
  it("anota una sola vez, en la base de siempre, y no programa nada", async () => {
    await recordUsage(INQUILINO, USUARIO, "gemini-2.5-flash", 100, 50, 0.0123);

    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]!.libro).toBe("inquilino");
    expect(h.tareas).toHaveLength(0);
  });
});

describe("recordUsage con BASE_POR_CLIENTE=1", () => {
  beforeEach(() => {
    process.env.BASE_POR_CLIENTE = "1";
  });

  it("anota en la base del inquilino y deja la copia en control para after()", async () => {
    await recordUsage(INQUILINO, USUARIO, "gemini-2.5-flash", 100, 50, 0.0123);

    // Al volver la llamada, control todavía no se escribió: va después de contestar.
    expect(h.inserts.map((i) => i.libro)).toEqual(["inquilino"]);
    expect(h.tareas).toHaveLength(1);

    await correrLoPendiente();

    expect(h.inserts.map((i) => i.libro)).toEqual(["inquilino", "control"]);
  });

  it("la copia es la misma fila, con el contexto del mismo inquilino", async () => {
    await recordUsage(INQUILINO, USUARIO, "gemini-2.5-flash", 100, 50, 0.0123);
    await correrLoPendiente();

    const [propia, copia] = h.inserts;
    expect(propia!.valores).toEqual({
      tenant_id: INQUILINO,
      user_id: USUARIO,
      model: "gemini-2.5-flash",
      prompt_tokens: 100,
      completion_tokens: 50,
      cost_usd: "0.0123",
    });
    expect(copia!.valores).toEqual(propia!.valores);
    expect(copia!.ctx).toEqual({ tenantId: INQUILINO });
  });

  it("registrarConsumoDelModelo también deja la copia", async () => {
    await registrarConsumoDelModelo(INQUILINO, "gemini-2.5-flash", {
      promptTokens: 10,
      completionTokens: 5,
    });
    await correrLoPendiente();

    expect(h.inserts.map((i) => i.libro)).toEqual(["inquilino", "control"]);
  });

  it("fuera de un pedido, donde after() tira, la copia se espera", async () => {
    h.afuera.valor = true;

    await recordUsage(INQUILINO, USUARIO, "gemini-2.5-flash", 100, 50, 0.0123);

    expect(h.tareas).toHaveLength(0);
    expect(h.inserts.map((i) => i.libro)).toEqual(["inquilino", "control"]);
  });

  it("si la copia falla, lo dice y no tira: el gasto sigue en la base del inquilino", async () => {
    h.fallos.control.push(new Error("control caído"));

    await expect(
      recordUsage(INQUILINO, USUARIO, "gemini-2.5-flash", 100, 50, 0.0123)
    ).resolves.toBeUndefined();
    await expect(correrLoPendiente()).resolves.toBeUndefined();

    expect(h.inserts.map((i) => i.libro)).toEqual(["inquilino"]);
    expect(h.error).toHaveBeenCalledWith({ error_name: "Error" }, "ai.usage_control_error");
  });

  it("un usuario que no existe se reintenta sin usuario también en control", async () => {
    h.fallos.inquilino.push({ code: "23503" });
    h.fallos.control.push({ code: "23503" });

    await recordUsage(INQUILINO, USUARIO, "gemini-2.5-flash", 100, 50, 0.0123);
    await correrLoPendiente();

    expect(h.inserts.map((i) => [i.libro, i.valores.user_id])).toEqual([
      ["inquilino", null],
      ["control", null],
    ]);
    expect(h.error).not.toHaveBeenCalled();
  });

  it("una falla que no es del usuario no se reintenta en control", async () => {
    h.fallos.control.push({ code: "42501" });

    await recordUsage(INQUILINO, USUARIO, "gemini-2.5-flash", 100, 50, 0.0123);
    await correrLoPendiente();

    expect(h.inserts.map((i) => i.libro)).toEqual(["inquilino"]);
    expect(h.error).toHaveBeenCalledWith({ error_name: "UnknownError" }, "ai.usage_control_error");
  });

  it("si falla la base del inquilino, el gasto igual llega al tope del proyecto", async () => {
    // Una base que todavía no existe (3D000) no puede dejar el gasto fuera de la suma global.
    h.fallos.inquilino.push(Object.assign(new Error("no existe"), { code: "3D000" }));

    await recordUsage(INQUILINO, USUARIO, "gemini-2.5-flash", 100, 50, 0.0123);
    await correrLoPendiente();

    expect(h.inserts.map((i) => i.libro)).toEqual(["control"]);
    expect(h.error).toHaveBeenCalledWith(
      { error_name: "Error" },
      "budget.exception_recording_ai_usage"
    );
  });

  it("el centinela ya vive en control: no se anota dos veces", async () => {
    await recordUsage(CENTINELA, null, "gemini-2.5-flash", 100, 50, 0.0123);
    await correrLoPendiente();

    expect(h.inserts).toHaveLength(1);
    expect(h.tareas).toHaveLength(0);
  });
});
