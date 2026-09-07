/**
 * El gasto de la demo pública tiene que quedar escrito, aunque nadie lo firme.
 *
 * `/api/demo/public-analyze` es el único endpoint del producto que corre sin
 * autenticación, y lo que de verdad lo acota no es el límite por IP —que se
 * esquiva rotando IPs, y eso cuesta centavos— sino el tope diario de la demo.
 * Ese tope lo calcula `checkDemoBudget` sumando sobre `ai_usage` del inquilino
 * de la demo. Si ahí no se escribe nada, el tope no puede dispararse nunca, y
 * un endpoint anónimo queda apoyado contra la tarjeta de Veltra.
 *
 * Ahí no se escribía nada. La ruta pasaba "demo-public" como usuario;
 * `ai_usage.user_id` es una columna uuid, así que Postgres rechazaba el INSERT
 * con 22P02, y el reintento sin usuario sólo miraba 23503. La fila se perdía
 * entera y el error quedaba en un `console.error`.
 *
 * Este archivo prueba las dos mitades del arreglo: que la ruta no invente un
 * usuario, y que `recordUsage` no pierda el gasto si alguna otra vez le llega
 * uno que no es un uuid.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const insertados: Record<string, unknown>[] = [];
// Códigos que la base va a tirar, en orden, uno por intento de INSERT.
const fallos: (string | null)[] = [];

vi.mock("server-only", () => ({}));

vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: (fila: Record<string, unknown>) => {
        const codigo = fallos.shift() ?? null;
        if (codigo) return Promise.reject(Object.assign(new Error("pg"), { code: codigo }));
        insertados.push(fila);
        return Promise.resolve();
      },
    }),
  },
  tables: { aiUsage: {} },
}));

import { recordUsage } from "@/server/ai/budget";

const DEMO = "20000000-0000-0000-0000-000000000002";

beforeEach(() => {
  insertados.length = 0;
  fallos.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recordUsage cuando el usuario no es un uuid", () => {
  it("no pierde el gasto: lo vuelve a escribir sin atribuir", async () => {
    fallos.push("22P02"); // el primer intento, con el usuario que no es uuid
    await recordUsage(DEMO, "demo-public", "gemini-2.5-flash", 100, 40, 0.0012);

    expect(insertados).toHaveLength(1);
    expect(insertados[0]).toMatchObject({ tenant_id: DEMO, user_id: null, prompt_tokens: 100 });
  });

  it("sigue reintentando ante una clave foránea rota", async () => {
    fallos.push("23503");
    await recordUsage(DEMO, "10000000-0000-0000-0000-000000000009", "m", 1, 2, 0.1);
    expect(insertados).toHaveLength(1);
    expect(insertados[0]).toMatchObject({ user_id: null });
  });

  it("pero NO reintenta ante cualquier otro fallo de la base", async () => {
    /*
     * El control. Un reintento indiscriminado grabaría todo sin atribuir en
     * cuanto la base tosa, que es el defecto viejo con más pasos.
     */
    fallos.push("53300"); // too_many_connections
    await recordUsage(DEMO, "10000000-0000-0000-0000-000000000009", "m", 1, 2, 0.1);
    expect(insertados).toHaveLength(0);
  });

  it("y el gasto de un usuario válido se atribuye, como siempre", async () => {
    await recordUsage(DEMO, "10000000-0000-0000-0000-000000000009", "m", 7, 8, 0.5);
    expect(insertados[0]).toMatchObject({ user_id: "10000000-0000-0000-0000-000000000009" });
  });
});

describe("la ruta anónima no inventa un usuario", () => {
  it("pasa null, no una cadena que parece un id", () => {
    const fuente = readFileSync("src/app/api/demo/public-analyze/route.ts", "utf8");
    expect(fuente).toContain("const DEMO_USER_ID = null;");
    // El nombre sigue apareciendo en el comentario que cuenta qué pasó; lo que
    // no puede volver es como VALOR.
    expect(fuente).not.toContain('DEMO_USER_ID = "demo-public"');
  });
});
