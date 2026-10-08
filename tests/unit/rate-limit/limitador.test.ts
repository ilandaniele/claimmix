/**
 * El limitador: falla cerrada y liberación exacta (H5).
 *
 * Dos cosas que hacían rendir de más al que ataca:
 *
 * - Si la base no contestaba, el contador dejaba pasar a todos. Para un login
 *   es lo correcto (sin base tampoco hay login); para una llamada al modelo, un
 *   mail del sistema o un alta, el hipo de la base era plata sin tope. Quien
 *   cuida plata pide `fallaCerrada`.
 * - `liberarCupo` restaba a ciegas, así que quien no había contado nada (o
 *   contó en otra ventana) igual le bajaba el contador a otro. Ahora devuelve
 *   sólo el intento que se contó, en la ventana donde se contó.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { execute, avisar } = vi.hoisted(() => ({ execute: vi.fn(), avisar: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { execute: (...a: unknown[]) => execute(...a) } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: avisar, info: vi.fn(), error: vi.fn() },
}));

import { liberarCupo, rateLimit } from "@/lib/rate-limit/index";
import { limpiarCreditos } from "@/lib/rate-limit/credito-local";
import { clearAllRateLimits } from "@/lib/rate-limit/memory";

const DIA = 24 * 60 * 60_000;
const AHORA = new Date("2026-10-07T15:30:00.000Z");
const MEDIANOCHE_DE_HOY = Date.parse("2026-10-07T00:00:00.000Z");
const MEDIANOCHE_DE_AYER = MEDIANOCHE_DE_HOY - DIA;

/** Lo que devuelve la sentencia del contador: los intentos de la ventana, ya con éste. */
function hits(n: number) {
  execute.mockResolvedValueOnce({ rows: [{ hits: n }] });
}

beforeEach(() => {
  execute.mockReset();
  avisar.mockReset();
  clearAllRateLimits();
  limpiarCreditos();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AHORA);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("fallaCerrada", () => {
  beforeEach(() => {
    vi.stubEnv("RATE_LIMIT_PROVIDER", "postgres");
    execute.mockRejectedValue(new Error("connection reset"));
  });

  it("con la base caída, el cupo que cuesta plata se cierra", async () => {
    const r = await rateLimit("ia:prueba:t-1", { limit: 39, windowMs: DIA, fallaCerrada: true });

    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.ventana).toBe(0);
    // «Probá en un rato», no «mañana»: la ventana es de un día y la base volvió en un segundo.
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
    expect(r.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(avisar).toHaveBeenCalledWith(
      { error: "Error" },
      "rate_limit.el_contador_no_contesto_y_se_cerro"
    );
  });

  it("sin la opción sigue abierto, como siempre", async () => {
    const r = await rateLimit("auth:ip:t-1", { limit: 30, windowMs: 60_000 });

    expect(r.allowed).toBe(true);
    expect(r.ventana).toBe(0);
  });

  it("también cierra el que reserva de a lotes, y no deja crédito de una reserva que no existió", async () => {
    const config = { limit: 39, windowMs: DIA, lote: 4, fallaCerrada: true };

    expect((await rateLimit("ia:prueba:t-2", config)).allowed).toBe(false);

    // Vuelve la base: el pedido siguiente tiene que ir a ella, no gastar un lote fantasma.
    execute.mockReset();
    hits(4);
    const r = await rateLimit("ia:prueba:t-2", config);
    expect(r.allowed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("cierra cuando el proveedor entero no está (Upstash sin instalar)", async () => {
    vi.stubEnv("RATE_LIMIT_PROVIDER", "upstash");

    const cerrado = await rateLimit("wa:plantilla:t-1", { limit: 3, windowMs: DIA, fallaCerrada: true });
    expect(cerrado.allowed).toBe(false);

    await expect(rateLimit("wa:plantilla:t-1", { limit: 3, windowMs: DIA })).rejects.toThrow(/Upstash/);
  });

  it("con la base sana no cambia nada: cuenta y frena en el límite", async () => {
    execute.mockReset();
    hits(3);
    hits(4);

    const config = { limit: 3, windowMs: DIA, fallaCerrada: true };
    expect((await rateLimit("alta:ip:t-1", config)).allowed).toBe(true);
    expect((await rateLimit("alta:ip:t-1", config)).allowed).toBe(false);
  });

  it("en memoria cuenta como siempre", async () => {
    vi.stubEnv("RATE_LIMIT_PROVIDER", "memory");
    const config = { limit: 1, windowMs: DIA, fallaCerrada: true };

    expect((await rateLimit("alta:ip:m-1", config)).allowed).toBe(true);
    expect((await rateLimit("alta:ip:m-1", config)).allowed).toBe(false);
  });
});

describe("ventana del resultado", () => {
  it("en la base es el window_start donde quedó contado", async () => {
    vi.stubEnv("RATE_LIMIT_PROVIDER", "postgres");
    hits(1);

    const r = await rateLimit("alta:ip:v-1", { limit: 3, windowMs: DIA });

    expect(r.ventana).toBe(MEDIANOCHE_DE_HOY);
  });

  it("en memoria es el instante del intento contado, y 0 si no entró", async () => {
    vi.stubEnv("RATE_LIMIT_PROVIDER", "memory");
    const config = { limit: 1, windowMs: 10_000 };

    const entra = await rateLimit("ventana:m-1", config);
    const noEntra = await rateLimit("ventana:m-1", config);

    expect(entra.ventana).toBe(AHORA.getTime());
    expect(noEntra.ventana).toBe(0);
  });
});

describe("liberarCupo en la base", () => {
  beforeEach(() => {
    vi.stubEnv("RATE_LIMIT_PROVIDER", "postgres");
  });

  it("resta uno en la ventana donde se contó, y la sentencia no baja de 0", async () => {
    execute.mockResolvedValueOnce({ rowCount: 1 });

    await liberarCupo("alta:ip:l-1", DIA, MEDIANOCHE_DE_HOY);

    expect(execute).toHaveBeenCalledTimes(1);
    const sentencia = JSON.stringify(execute.mock.calls[0][0]);
    expect(sentencia).toContain("greatest(hits - 1, 0)");
    expect(sentencia).toContain("bucket_key");
    expect(sentencia).toContain("window_start");
    expect(sentencia).toContain("alta:ip:l-1");
    expect(sentencia).toContain(new Date(MEDIANOCHE_DE_HOY).toISOString());
  });

  it("con una ventana vieja no resta nada", async () => {
    await liberarCupo("alta:ip:l-2", DIA, MEDIANOCHE_DE_AYER);

    expect(execute).not.toHaveBeenCalled();
  });

  it("si la ventana cambió entre contar y liberar, no resta nada", async () => {
    vi.setSystemTime(new Date("2026-10-07T23:59:59.000Z"));
    hits(1);
    const r = await rateLimit("alta:ip:l-3", { limit: 3, windowMs: DIA });
    expect(r.ventana).toBe(MEDIANOCHE_DE_HOY);

    vi.setSystemTime(new Date("2026-10-08T00:00:01.000Z"));
    execute.mockClear();
    await liberarCupo("alta:ip:l-3", DIA, r.ventana);

    expect(execute).not.toHaveBeenCalled();
  });

  it("quien no llegó a contar nada (la base no contestó) no libera nada", async () => {
    execute.mockRejectedValueOnce(new Error("connection reset"));
    const r = await rateLimit("ia:prueba:l-4", { limit: 39, windowMs: DIA });
    expect(r.allowed).toBe(true);
    execute.mockClear();

    await liberarCupo("ia:prueba:l-4", DIA, r.ventana);

    expect(execute).not.toHaveBeenCalled();
  });
});

describe("liberarCupo en memoria", () => {
  beforeEach(() => {
    vi.stubEnv("RATE_LIMIT_PROVIDER", "memory");
  });

  it("devuelve el intento contado y no abre más que uno", async () => {
    const config = { limit: 2, windowMs: DIA };
    const primero = await rateLimit("liberar:m-1", config);
    vi.setSystemTime(AHORA.getTime() + 5);
    await rateLimit("liberar:m-1", config);
    expect((await rateLimit("liberar:m-1", config)).allowed).toBe(false);

    await liberarCupo("liberar:m-1", DIA, primero.ventana);
    // Devolverlo otra vez no abre otro: el intento ya no está.
    await liberarCupo("liberar:m-1", DIA, primero.ventana);

    expect((await rateLimit("liberar:m-1", config)).allowed).toBe(true);
    expect((await rateLimit("liberar:m-1", config)).allowed).toBe(false);
  });

  it("quien no tomó el cupo no lo libera: el rechazado no le abre lugar a otro", async () => {
    const config = { limit: 1, windowMs: DIA };
    const dueno = await rateLimit("liberar:m-2", config);
    const rechazado = await rateLimit("liberar:m-2", config);
    expect(dueno.allowed).toBe(true);
    expect(rechazado.allowed).toBe(false);

    await liberarCupo("liberar:m-2", DIA, rechazado.ventana);

    expect((await rateLimit("liberar:m-2", config)).allowed).toBe(false);
  });

  it("un cupo que nunca se usó no rompe y el contador no baja de 0", async () => {
    await expect(liberarCupo("liberar:nunca", DIA, AHORA.getTime())).resolves.toBeUndefined();

    const config = { limit: 1, windowMs: DIA };
    expect((await rateLimit("liberar:nunca", config)).allowed).toBe(true);
    expect((await rateLimit("liberar:nunca", config)).allowed).toBe(false);
  });
});
