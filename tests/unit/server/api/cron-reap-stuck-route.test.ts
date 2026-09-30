/**
 * El barrido nocturno (B4, B22, B19): los recordatorios corren entre retomar y
 * cerrar, el aviso de cierre después del cierre, la revisión de desvíos al
 * final de los barridos de casos, la purga de adjuntos y la retención sólo en la
 * ventana de las 04 UTC y una vez por día, y si uno falla lo demás corre igual.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  orden: [] as string[],
  reap: vi.fn(),
  retomar: vi.fn(),
  recordar: vi.fn(),
  cerrar: vi.fn(),
  avisar: vi.fn(),
  revisar: vi.fn(),
  purgar: vi.fn(),
  purgaAdjuntos: vi.fn(),
  retencion: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/intake/reap-stuck", () => ({ reapStuckProcessingCases: m.reap }));
vi.mock("@/server/intake/retomar-pendientes", () => ({ retomarExtraccionesPendientes: m.retomar }));
vi.mock("@/server/confirmations/recordatorios", () => ({ recordarPendientes: m.recordar, avisarCierres: m.avisar }));
vi.mock("@/server/intake/close-abandoned", () => ({ closeAbandonedConversations: m.cerrar }));
vi.mock("@/server/desvios/revision-nocturna", () => ({ revisarDesvios: m.revisar }));
vi.mock("@/server/storage/purgar-adjuntos", () => ({ purgarAdjuntos: m.purgaAdjuntos }));
vi.mock("@/server/cases/retencion", () => ({ aplicarRetencion: m.retencion }));
vi.mock("@/lib/rate-limit/postgres", () => ({ purgeExpiredRateLimits: m.purgar }));
vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: m.rateLimit,
  RATE_LIMIT_CONFIGS: {
    REVISION_DE_DESVIOS: { limit: 1, windowMs: 86_400_000 },
    PURGA_Y_RETENCION: { limit: 1, windowMs: 86_400_000 },
  },
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { GET } from "@/app/api/cron/reap-stuck/route";

const SECRETO = "secreto-de-prueba";
const FUERA_DE_VENTANA = new Date("2026-09-30T12:00:00Z");
const EN_VENTANA = new Date("2026-09-30T04:10:00Z");
const pedido = () =>
  new NextRequest("http://localhost/api/cron/reap-stuck", {
    headers: { authorization: `Bearer ${SECRETO}` },
  });

function anota<T>(nombre: string, valor: T) {
  return async () => {
    m.orden.push(nombre);
    return valor;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FUERA_DE_VENTANA);
  m.orden.length = 0;
  vi.stubEnv("CRON_SECRET", SECRETO);
  m.reap.mockImplementation(anota("reap", { reaped: 2 }));
  m.retomar.mockImplementation(anota("retomar", { retomados: 1 }));
  m.recordar.mockImplementation(anota("recordar", { enviados: 3, salteados: 1 }));
  m.cerrar.mockImplementation(anota("cerrar", { closed: 4, caseIds: [] }));
  m.avisar.mockImplementation(anota("avisar", 2));
  m.revisar.mockImplementation(anota("revisar", { nuevos: 6, porRegla: {} }));
  m.purgar.mockImplementation(anota("purgar", 5));
  m.purgaAdjuntos.mockImplementation(anota("purgaAdjuntos", { modo: "borrar", candidatos: 3, purgados: 2, fallidos: 1 }));
  m.retencion.mockImplementation(
    anota("retencion", { modo: "borrar", anios: 5, corte: "2021-09-30T04:10:00.000Z", inquilinos: 1, candidatos: 2, borrados: 2 })
  );
  m.rateLimit.mockResolvedValue({ allowed: true, remaining: 0, retryAfterSeconds: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/cron/reap-stuck", () => {
  it("corre reap, retomar, recordatorios, cierre, avisos de cierre, desvíos y purga, en ese orden", async () => {
    await GET(pedido());
    expect(m.orden).toEqual(["reap", "retomar", "recordar", "cerrar", "avisar", "revisar", "purgar"]);
  });

  it("la revisión de desvíos corre una vez por día aunque la ruta la llamen cada quince minutos", async () => {
    // La primera llamada del día se lleva el cupo; las siguientes lo encuentran agotado.
    m.rateLimit
      .mockResolvedValueOnce({ allowed: true, remaining: 0, retryAfterSeconds: 0 })
      .mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 900 });

    const primera = await GET(pedido());
    const segunda = await GET(pedido());
    const tercera = await GET(pedido());

    expect(m.rateLimit).toHaveBeenCalledTimes(3);
    expect(m.rateLimit).toHaveBeenCalledWith("revision-de-desvios", { limit: 1, windowMs: 86_400_000 });
    expect(m.revisar).toHaveBeenCalledOnce();
    expect(await primera.json()).toMatchObject({ desvios_nuevos: 6 });
    expect(await segunda.json()).toMatchObject({ desvios_nuevos: 0 });
    expect(await tercera.json()).toMatchObject({ desvios_nuevos: 0 });
  });

  it("sin cupo de revisión los demás barridos y la purga corren igual", async () => {
    m.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 900 });

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(m.orden).toEqual(["reap", "retomar", "recordar", "cerrar", "avisar", "purgar"]);
  });

  it("si el cupo no se puede consultar la revisión no corre y la purga sí", async () => {
    m.rateLimit.mockRejectedValue(new Error("se cayó"));

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(m.revisar).not.toHaveBeenCalled();
    expect(m.purgar).toHaveBeenCalledOnce();
  });

  it("un error en la revisión de desvíos no corta la purga y cuenta cero", async () => {
    m.revisar.mockRejectedValue(new Error("se cayó"));

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(m.purgar).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({ desvios_nuevos: 0, rate_limit_rows_purged: 5 });
  });

  it("no arranca la revisión de desvíos si no queda un minuto de la función", async () => {
    const reloj = vi.spyOn(Date, "now");
    // El primer valor fija `hasta`; el resto ya está pasado el margen.
    reloj.mockReturnValueOnce(0).mockReturnValue(300_000);

    const res = await GET(pedido());
    reloj.mockRestore();

    expect(res.status).toBe(200);
    expect(m.revisar).not.toHaveBeenCalled();
    expect(m.purgar).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({ desvios_nuevos: 0 });
  });

  it("los recordatorios tienen a lo sumo un minuto y los avisos dejan un minuto antes del plazo", async () => {
    const antes = Date.now();
    await GET(pedido());

    const { hasta: hastaRecordatorios } = m.recordar.mock.calls[0][0];
    const { hasta: hastaAvisos } = m.avisar.mock.calls[0][0];
    const hasta = m.retomar.mock.calls[0][0].hasta;
    expect(hastaRecordatorios).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(hastaRecordatorios).toBeGreaterThanOrEqual(antes + 60_000);
    expect(hastaAvisos).toBe(hasta - 60_000);
  });

  it("un error en los avisos de cierre no corta la purga", async () => {
    m.avisar.mockRejectedValue(new Error("se cayó"));

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(m.purgar).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({ abandoned_closed: 4, avisos_de_cierre: 0 });
  });

  it("un error en los recordatorios no corta el cierre", async () => {
    m.recordar.mockRejectedValue(new Error("se cayó"));

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(m.cerrar).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({ recordatorios_enviados: 0, recordatorios_salteados: 0 });
  });

  it("el JSON trae los recordatorios, los avisos y los desvíos nuevos, y conserva lo de antes", async () => {
    const res = await GET(pedido());

    expect(await res.json()).toEqual({
      ok: true,
      reaped: 2,
      retomados: 1,
      abandoned_closed: 4,
      recordatorios_enviados: 3,
      recordatorios_salteados: 1,
      avisos_de_cierre: 2,
      desvios_nuevos: 6,
      purga: null,
      retencion: null,
      rate_limit_rows_purged: 5,
    });
  });
});

describe("GET /api/cron/reap-stuck: la purga de adjuntos y la retención (B19)", () => {
  it("fuera de las 04 UTC ninguna corre y sus claves van en null", async () => {
    for (const hora of ["00:00", "03:59", "05:00", "12:00", "23:45"]) {
      vi.setSystemTime(new Date(`2026-09-30T${hora}:00Z`));
      const res = await GET(pedido());
      expect(await res.json()).toMatchObject({ purga: null, retencion: null });
    }

    expect(m.purgaAdjuntos).not.toHaveBeenCalled();
    expect(m.retencion).not.toHaveBeenCalled();
    // Y fuera de la ventana no se gasta el cupo del día: lo necesita la llamada de las 04.
    expect(m.rateLimit).not.toHaveBeenCalledWith("purga-y-retencion", expect.anything());
  });

  it("la ventana dura una hora y la ruta se llama cada quince minutos: sólo la primera llamada del día corre", async () => {
    // Regresión: sin el cupo, las cinco llamadas de las 04 UTC corrían la purga, gastaban sus
    // cinco intentos en una hora y dejaban a un adjunto fallido sin reintento en los días siguientes.
    m.rateLimit.mockImplementation(async (clave: string) =>
      clave === "purga-y-retencion" && m.rateLimit.mock.calls.filter(([c]) => c === clave).length > 1
        ? { allowed: false, remaining: 0, retryAfterSeconds: 900 }
        : { allowed: true, remaining: 0, retryAfterSeconds: 0 }
    );
    const respuestas = [];
    for (const minuto of ["04:00", "04:15", "04:30", "04:45", "04:59"]) {
      vi.setSystemTime(new Date(`2026-09-30T${minuto}:00Z`));
      respuestas.push(await GET(pedido()));
    }

    expect(m.rateLimit).toHaveBeenCalledWith("purga-y-retencion", { limit: 1, windowMs: 86_400_000 });
    expect(m.purgaAdjuntos).toHaveBeenCalledOnce();
    expect(m.retencion).toHaveBeenCalledOnce();
    expect(await respuestas[0].json()).toMatchObject({ purga: { purgados: 2 }, retencion: { borrados: 2 } });
    expect(await respuestas[4].json()).toMatchObject({ purga: null, retencion: null });
  });

  it("sin cupo del día no corre ninguna de las dos, y el resto del barrido sí", async () => {
    vi.setSystemTime(EN_VENTANA);
    m.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 900 });

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(m.purgaAdjuntos).not.toHaveBeenCalled();
    expect(m.retencion).not.toHaveBeenCalled();
    expect(m.purgar).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({ purga: null, retencion: null });
  });

  it("si el cupo no se puede consultar no se borra nada: ante la duda, mañana", async () => {
    vi.setSystemTime(EN_VENTANA);
    m.rateLimit.mockImplementation(async (clave: string) => {
      if (clave === "purga-y-retencion") throw new Error("se cayó");
      return { allowed: true, remaining: 0, retryAfterSeconds: 0 };
    });

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(m.purgaAdjuntos).not.toHaveBeenCalled();
    expect(m.retencion).not.toHaveBeenCalled();
    expect(m.purgar).toHaveBeenCalledOnce();
  });

  it("no pide el cupo si no queda un minuto de la función: no lo gasta sin correr", async () => {
    vi.setSystemTime(EN_VENTANA);
    const reloj = vi.spyOn(Date, "now");
    reloj.mockReturnValueOnce(0).mockReturnValue(300_000);

    await GET(pedido());
    reloj.mockRestore();

    expect(m.rateLimit).not.toHaveBeenCalledWith("purga-y-retencion", expect.anything());
    expect(m.purgaAdjuntos).not.toHaveBeenCalled();
  });

  it.each(["04:00", "04:10", "04:59"])("a las %s UTC corren las dos", async (hora) => {
    vi.setSystemTime(new Date(`2026-09-30T${hora}:00Z`));

    await GET(pedido());

    expect(m.purgaAdjuntos).toHaveBeenCalledOnce();
    expect(m.retencion).toHaveBeenCalledOnce();
  });

  it("en la ventana corren después de los avisos y la revisión, y antes de la purga del rate limit", async () => {
    vi.setSystemTime(EN_VENTANA);

    await GET(pedido());

    expect(m.orden).toEqual([
      "reap",
      "retomar",
      "recordar",
      "cerrar",
      "avisar",
      "revisar",
      "purgaAdjuntos",
      "retencion",
      "purgar",
    ]);
  });

  it("las dos reciben el plazo de la función menos un minuto", async () => {
    vi.setSystemTime(EN_VENTANA);

    await GET(pedido());

    const hasta = m.retomar.mock.calls[0][0].hasta;
    expect(m.purgaAdjuntos).toHaveBeenCalledWith({ hasta: hasta - 60_000 });
    expect(m.retencion).toHaveBeenCalledWith({ hasta: hasta - 60_000 });
  });

  it("el JSON trae lo que devolvió cada una", async () => {
    vi.setSystemTime(EN_VENTANA);

    const res = await GET(pedido());

    expect(await res.json()).toMatchObject({
      purga: { modo: "borrar", candidatos: 3, purgados: 2, fallidos: 1 },
      retencion: { modo: "borrar", anios: 5, inquilinos: 1, candidatos: 2, borrados: 2 },
    });
  });

  it("apagadas (devuelven null) el JSON lo dice y el resto del barrido corre igual", async () => {
    vi.setSystemTime(EN_VENTANA);
    m.purgaAdjuntos.mockImplementation(anota("purgaAdjuntos", null));
    m.retencion.mockImplementation(anota("retencion", null));

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ purga: null, retencion: null, rate_limit_rows_purged: 5 });
    expect(m.purgar).toHaveBeenCalledOnce();
  });

  it("si la purga de adjuntos falla, la retención y la purga del rate limit corren igual", async () => {
    vi.setSystemTime(EN_VENTANA);
    m.purgaAdjuntos.mockRejectedValue(new Error("se cayó"));

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(m.retencion).toHaveBeenCalledOnce();
    expect(m.purgar).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({ purga: null, retencion: { borrados: 2 } });
  });

  it("si la retención falla, la purga de adjuntos ya corrió y la del rate limit corre igual", async () => {
    vi.setSystemTime(EN_VENTANA);
    m.retencion.mockRejectedValue(new Error("se cayó"));

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(m.purgaAdjuntos).toHaveBeenCalledOnce();
    expect(m.purgar).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({ purga: { purgados: 2 }, retencion: null });
  });

  it("el error no deja nada del mensaje en el log: sólo el código", async () => {
    vi.setSystemTime(EN_VENTANA);
    const { logger } = await import("@/lib/observability/logger");
    m.purgaAdjuntos.mockRejectedValue(new Error("clave-secreta-de-r2"));

    await GET(pedido());

    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("clave-secreta-de-r2");
  });
});
