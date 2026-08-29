/**
 * El limitador tiene que contar una sola vez, no una vez por instancia.
 *
 * El de memoria contaba por proceso, y la prueba de carga mostró lo que eso
 * significa en serverless: cien pedidos simultáneos los atendió Vercel
 * levantando instancias, cada una arrancando su cuenta en cero. Quien manda
 * los pedidos en paralelo es justamente a quien el límite tiene que frenar,
 * así que el control se debilitaba exactamente cuando lo atacaban.
 *
 * Lo que se prueba acá es que la cuenta ahora vive en un solo lugar y que
 * ninguna de las dos maneras de fallar es peor que el problema: ni contar de
 * más (bloquear a alguien legítimo) ni caerse con la base (bloquear a todos).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execute = vi.fn();

vi.mock("@/lib/db", () => ({ db: { execute: (...a: unknown[]) => execute(...a) } }));
vi.mock("server-only", () => ({}));

import { checkRateLimitPostgres, purgeExpiredRateLimits } from "@/lib/rate-limit/postgres";
import { resolveProvider } from "@/lib/rate-limit/index";

const SAVED = { ...process.env };

beforeEach(() => {
  execute.mockReset();
});

afterEach(() => {
  process.env = { ...SAVED };
});

/** Lo que devuelve la sentencia: el contador después de sumar este intento. */
function hits(n: number) {
  execute.mockResolvedValueOnce({ rows: [{ hits: n }] });
}

describe("checkRateLimitPostgres", () => {
  it("deja pasar mientras el contador no supere el límite", async () => {
    hits(5);
    const r = await checkRateLimitPostgres("signin:1.2.3.4:a@b.com", 5, 10_000);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it("frena el intento siguiente", async () => {
    hits(6);
    const r = await checkRateLimitPostgres("signin:1.2.3.4:a@b.com", 5, 10_000);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it("cuenta con una sola sentencia, que es lo que la hace atómica", async () => {
    // Leer-contar-escribir sería una carrera entre instancias: dos que leen 4
    // al mismo tiempo escriben 5 las dos, y pasan seis intentos.
    hits(1);
    await checkRateLimitPostgres("k", 5, 10_000);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("todas las instancias caen en la misma ventana", async () => {
    // La ventana se deriva del reloj, no de cuándo llegó el primer pedido a
    // esta instancia. Si dependiera de eso, cada instancia tendría su propia
    // ventana y estaríamos donde empezamos.
    const capture: string[] = [];
    execute.mockImplementation((q: { queryChunks?: unknown[] }) => {
      capture.push(JSON.stringify(q));
      return Promise.resolve({ rows: [{ hits: 1 }] });
    });

    await checkRateLimitPostgres("k", 5, 60_000);
    await checkRateLimitPostgres("k", 5, 60_000);

    // Dos llamadas seguidas dentro del mismo minuto usan el mismo window_start.
    expect(capture[0]).toBe(capture[1]);
  });

  it("cuando la base no contesta, deja pasar en vez de bloquear a todos", async () => {
    // Fallar cerrado no compraría nada: sin base no hay login posible de todos
    // modos, y convertiría un hipo de la base en una caída del producto.
    execute.mockRejectedValueOnce(new Error("connection reset"));
    const r = await checkRateLimitPostgres("k", 5, 10_000);
    expect(r.allowed).toBe(true);
  });

  it("un contador raro no bloquea a nadie por accidente", async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    const r = await checkRateLimitPostgres("k", 5, 10_000);
    expect(r.allowed).toBe(true);
  });
});

describe("purgeExpiredRateLimits", () => {
  it("borra y dice cuántas", async () => {
    execute.mockResolvedValueOnce({ rowCount: 42 });
    expect(await purgeExpiredRateLimits()).toBe(42);
  });

  it("no rompe el cron si el borrado falla", async () => {
    execute.mockRejectedValueOnce(new Error("timeout"));
    expect(await purgeExpiredRateLimits()).toBe(0);
  });
});

describe("resolveProvider", () => {
  it("en los tests usa memoria: son sobre la lógica, no sobre la base", () => {
    process.env.NODE_ENV = "test";
    delete process.env.RATE_LIMIT_PROVIDER;
    expect(resolveProvider()).toBe("memory");
  });

  it("en producción usa la base, que es lo único compartido", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://…";
    delete process.env.RATE_LIMIT_PROVIDER;
    expect(resolveProvider()).toBe("postgres");
  });

  /*
   * «Memoria es mejor que no limitar nada» decía este test, y en serverless son
   * la misma cosa.
   *
   * Cada invocación arranca con su propio mapa vacío, así que el sexto intento
   * de la ventana casi nunca cae en la instancia que vio los cinco anteriores:
   * el tope del login deja de existir y nada falla. Sigue cayendo a memoria
   * —tirar la aplicación abajo porque falta una variable es peor— pero ahora lo
   * grita.
   */
  it("sin base cae a memoria, y lo dice", () => {
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    delete process.env.RATE_LIMIT_PROVIDER;
    const grito = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(resolveProvider()).toBe("memory");

    expect(grito).toHaveBeenCalledTimes(1);
    const linea = JSON.parse(grito.mock.calls[0][0] as string);
    expect(linea.level).toBe("error");
    expect(linea.msg).toBe("rate_limit.memoria_en_produccion");
    // Por qué pasó, no sólo que pasó: es lo que se necesita para arreglarlo.
    expect(linea.motivo).toMatch(/DATABASE_URL/);
    grito.mockRestore();
  });

  it("forzar memoria en producción también avisa", () => {
    // Es la otra forma de llegar al mismo lugar, y la más fácil de hacer sin
    // querer: alguien pone la variable para una prueba y queda.
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://…";
    process.env.RATE_LIMIT_PROVIDER = "memory";
    const grito = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(resolveProvider()).toBe("memory");
    expect(grito).toHaveBeenCalledTimes(1);
    grito.mockRestore();
  });

  it("con base en producción no molesta a nadie", () => {
    // La otra mitad: un aviso que salta siempre se aprende a ignorar.
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://…";
    delete process.env.RATE_LIMIT_PROVIDER;
    const grito = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(resolveProvider()).toBe("postgres");
    expect(grito).not.toHaveBeenCalled();
    grito.mockRestore();
  });

  it("en desarrollo tampoco: ahí memoria es lo correcto", () => {
    process.env.NODE_ENV = "development";
    delete process.env.DATABASE_URL;
    delete process.env.RATE_LIMIT_PROVIDER;
    const grito = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(resolveProvider()).toBe("memory");
    expect(grito).not.toHaveBeenCalled();
    grito.mockRestore();
  });

  it("se puede forzar", () => {
    process.env.NODE_ENV = "test";
    process.env.RATE_LIMIT_PROVIDER = "upstash";
    expect(resolveProvider()).toBe("upstash");
  });
});
