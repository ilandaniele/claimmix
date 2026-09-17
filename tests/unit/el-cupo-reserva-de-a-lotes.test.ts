/**
 * `GET /api/cases` es la ruta que más corre del producto: la bandeja la
 * sondea cada 5 a 30 segundos por pestaña abierta, y hasta ahora cada sondeo
 * escribía en la base sólo para contar el pedido (`postgres.ts`, un
 * `insert … on conflict do update` serializado por el lock de la fila).
 *
 * Lo que se prueba acá es la reserva de a lotes: `CASES_API` carga cinco cupos
 * de una sola escritura y los gasta en memoria, pedido a pedido, hasta que se
 * acaban. El resto de los perfiles —todos los de autenticación— no tiene
 * `lote` y sigue escribiendo en cada intento, que es lo que los hace servir
 * contra fuerza bruta.
 *
 * La base se mockea igual que en `rate-limit-postgres.test.ts`: no hay Neon
 * acá, sólo lo que `db.execute` devuelve.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execute = vi.fn();

vi.mock("@/lib/db", () => ({ db: { execute: (...a: unknown[]) => execute(...a) } }));
vi.mock("server-only", () => ({}));

import { rateLimit, RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { limpiarCreditos } from "@/lib/rate-limit/credito-local";

const SAVED = { ...process.env };

/** Lo que devuelve la sentencia: el contador después de sumar el lote entero. */
function hits(n: number) {
  execute.mockResolvedValueOnce({ rows: [{ hits: n }] });
}

beforeEach(() => {
  execute.mockReset();
  limpiarCreditos();
  // Bajo vitest NODE_ENV=test resuelve a memoria; acá se prueba la reserva de
  // a lotes, que sólo tiene sentido contra la base que se quiere aliviar.
  process.env.RATE_LIMIT_PROVIDER = "postgres";
});

afterEach(() => {
  process.env = { ...SAVED };
  vi.useRealTimers();
});

describe("CASES_API reserva de a lotes", () => {
  it("cinco llamadas seguidas con CASES_API hacen UNA sola escritura", async () => {
    hits(5);
    const key = "cases:cinco-seguidas";

    for (let i = 0; i < 5; i++) {
      const r = await rateLimit(key, RATE_LIMIT_CONFIGS.CASES_API);
      expect(r.allowed).toBe(true);
    }

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("la sexta escribe", async () => {
    hits(5);
    const key = "cases:la-sexta-escribe";

    for (let i = 0; i < 5; i++) {
      await rateLimit(key, RATE_LIMIT_CONFIGS.CASES_API);
    }
    expect(execute).toHaveBeenCalledTimes(1);

    hits(10); // el lote anterior se agotó: hace falta uno nuevo
    await rateLimit(key, RATE_LIMIT_CONFIGS.CASES_API);

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("esa escritura suma cinco y no uno", async () => {
    const capturas: unknown[][] = [];
    execute.mockImplementation((q: { queryChunks?: unknown[] }) => {
      capturas.push(q.queryChunks ?? []);
      const total = capturas.length === 1 ? 5 : 10;
      return Promise.resolve({ rows: [{ hits: total }] });
    });

    const key = "cases:suma-de-a-lote";
    for (let i = 0; i < 5; i++) {
      await rateLimit(key, RATE_LIMIT_CONFIGS.CASES_API);
    }
    await rateLimit(key, RATE_LIMIT_CONFIGS.CASES_API); // agota el lote, escribe de nuevo

    expect(capturas).toHaveLength(2);
    // El valor inicial del insert y el incremento del conflicto son el lote
    // (cinco), no un uno pegado a mano por cada pedido.
    expect(capturas[1]).toContain(RATE_LIMIT_CONFIGS.CASES_API.lote);
    expect(capturas[1]).not.toContain(1);
  });

  it("un perfil de autenticación escribe las cinco veces", async () => {
    // AUTH_SIGN_IN no tiene `lote`: es la defensa contra fuerza bruta, y no es
    // negociable que deje de contar en la base en cada intento.
    expect("lote" in RATE_LIMIT_CONFIGS.AUTH_SIGN_IN).toBe(false);

    hits(1);
    hits(2);
    hits(3);
    hits(4);
    hits(5);

    const key = "signin:1.2.3.4:a@b.com";
    for (let i = 0; i < 5; i++) {
      await rateLimit(key, RATE_LIMIT_CONFIGS.AUTH_SIGN_IN);
    }

    expect(execute).toHaveBeenCalledTimes(5);
  });

  it("cambiar de ventana descarta el crédito que sobraba", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const key = "cases:cambio-de-ventana";
    hits(5);
    await rateLimit(key, RATE_LIMIT_CONFIGS.CASES_API); // usa 1 de 5, escribe
    await rateLimit(key, RATE_LIMIT_CONFIGS.CASES_API); // usa 2 de 5, no escribe
    expect(execute).toHaveBeenCalledTimes(1);

    // La ventana de 60s cambia con tres créditos del lote todavía sin usar.
    vi.setSystemTime(new Date(60_000));

    hits(5); // el contador de la base arranca de nuevo para la ventana nueva
    await rateLimit(key, RATE_LIMIT_CONFIGS.CASES_API);

    // Si el sobrante hubiera cruzado de ventana, este pedido no habría escrito.
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("nunca aprueba si el contador remoto ya pasó el límite", async () => {
    // El contador ya venía en 200 antes de esta reserva; sumado el lote de
    // cinco, la base devuelve 205 — muy por encima del límite de cien.
    hits(205);

    const key = "cases:contador-ya-pasado";
    const resultados = [];
    for (let i = 0; i < 5; i++) {
      resultados.push(await rateLimit(key, RATE_LIMIT_CONFIGS.CASES_API));
    }

    expect(resultados.every((r) => r.allowed === false)).toBe(true);
  });
});
