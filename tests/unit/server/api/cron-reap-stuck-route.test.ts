/**
 * El barrido nocturno (B4, B22, B19): los recordatorios corren entre retomar y
 * cerrar, el aviso de cierre después del cierre, la revisión de desvíos al
 * final de los barridos de casos y seguida del aviso a cada aseguradora con
 * desvíos nuevos, la purga de adjuntos y la retención sólo en la ventana de las
 * 04 UTC y una vez por día, y si uno falla lo demás corre igual.
 *
 * Con `BASE_POR_CLIENTE=1` (P10) cada barrido de casos corre por cada base de
 * cliente, y al final se vuelven a lanzar las bases a medias y se espeja control.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { DbDueno } from "@/lib/db";

const m = vi.hoisted(() => ({
  orden: [] as string[],
  reap: vi.fn(),
  retomar: vi.fn(),
  recordar: vi.fn(),
  cerrar: vi.fn(),
  avisar: vi.fn(),
  revisar: vi.fn(),
  avisarDesvios: vi.fn(),
  purgar: vi.fn(),
  purgaAdjuntos: vi.fn(),
  retencion: vi.fn(),
  rateLimit: vi.fn(),
  paraCadaBase: vi.fn(),
  reintentar: vi.fn(),
  espejar: vi.fn(),
  revisarWabas: vi.fn(),
}));

// La base que el recorrido le da a cada barrido cuando la bandera está apagada.
const BASE_DE_CONTROL = { base: "control" } as unknown as DbDueno;

vi.mock("server-only", () => ({}));
vi.mock("@/server/intake/reap-stuck", () => ({ reapStuckProcessingCases: m.reap }));
vi.mock("@/server/intake/retomar-pendientes", () => ({ retomarExtraccionesPendientes: m.retomar }));
vi.mock("@/server/confirmations/recordatorios", () => ({ recordarPendientes: m.recordar, avisarCierres: m.avisar }));
vi.mock("@/server/intake/close-abandoned", () => ({ closeAbandonedConversations: m.cerrar }));
vi.mock("@/server/desvios/revision-nocturna", () => ({ revisarDesvios: m.revisar }));
vi.mock("@/server/notify/specialist-alert", () => ({ avisarDesvios: m.avisarDesvios }));
vi.mock("@/server/storage/purgar-adjuntos", () => ({ purgarAdjuntos: m.purgaAdjuntos }));
vi.mock("@/server/cases/retencion", () => ({ aplicarRetencion: m.retencion }));
vi.mock("@/lib/rate-limit/postgres", () => ({ purgeExpiredRateLimits: m.purgar }));
vi.mock("@/server/bases/cada-base", () => ({ paraCadaBase: m.paraCadaBase }));
vi.mock("@/server/bases/reintentar", () => ({ reintentarBases: m.reintentar }));
vi.mock("@/server/bases/espejo", () => ({ espejarTodas: m.espejar }));
vi.mock("@/server/alta/waba-salud", () => ({ revisarWabas: m.revisarWabas }));
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

type Trabajo = (db: DbDueno, tenantId: string | null) => Promise<unknown>;

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
  vi.stubEnv("BASE_POR_CLIENTE", "");
  m.paraCadaBase.mockImplementation(async (trabajo: Trabajo) => ({
    resultados: [await trabajo(BASE_DE_CONTROL, null)],
    pendientes: 0,
    fallas: 0,
  }));
  m.reintentar.mockResolvedValue({ lanzadas: 0 });
  m.espejar.mockResolvedValue({ ok: 0, fallas: 0 });
  m.revisarWabas.mockResolvedValue(undefined);
  m.reap.mockImplementation(anota("reap", { reaped: 2, caseIds: [] }));
  m.retomar.mockImplementation(anota("retomar", { retomados: 1 }));
  m.recordar.mockImplementation(anota("recordar", { enviados: 3, salteados: 1 }));
  m.cerrar.mockImplementation(anota("cerrar", { closed: 4, caseIds: [] }));
  m.avisar.mockImplementation(anota("avisar", 2));
  m.revisar.mockImplementation(anota("revisar", { nuevos: 6, porRegla: {}, porInquilino: {}, fallidas: [] }));
  m.avisarDesvios.mockResolvedValue(true);
  m.purgar.mockImplementation(anota("purgar", 5));
  m.purgaAdjuntos.mockImplementation(anota("purgaAdjuntos", { modo: "borrar", candidatos: 3, purgados: 2, fallidos: 1 }));
  m.retencion.mockImplementation(
    anota("retencion", { modo: "borrar", anios: 5, corte: "2021-09-30T04:10:00.000Z", inquilinos: 1, candidatos: 2, borrados: 2 })
  );
  m.rateLimit.mockResolvedValue({ allowed: true, remaining: 0, retryAfterSeconds: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
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
    expect(await segunda.json()).toMatchObject({ desvios_nuevos: 0, desvios_fallidas: [] });
    expect(await tercera.json()).toMatchObject({ desvios_nuevos: 0, desvios_fallidas: [] });
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
    expect(await res.json()).toMatchObject({ desvios_nuevos: 0, desvios_fallidas: [], rate_limit_rows_purged: 5 });
  });

  it("las reglas que fallaron viajan en el JSON y la ruta sigue en 200", async () => {
    m.revisar.mockResolvedValue({
      nuevos: 1,
      porRegla: {},
      porInquilino: {},
      fallidas: ["plazo_vencido", "cierre_sin_listo"],
    });

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      desvios_nuevos: 1,
      desvios_fallidas: ["plazo_vencido", "cierre_sin_listo"],
    });
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
    expect(await res.json()).toMatchObject({ desvios_nuevos: 0, desvios_fallidas: [] });
  });

  it("avisa a cada aseguradora con desvíos nuevos, con sus propios conteos, y cuenta los avisos", async () => {
    m.revisar.mockResolvedValue({
      nuevos: 3,
      porRegla: { doc_sin_recibir: 2, plazo_vencido: 1 },
      porInquilino: { "tenant-a": { doc_sin_recibir: 2 }, "tenant-b": { plazo_vencido: 1 } },
      fallidas: [],
    });

    const res = await GET(pedido());

    expect(m.avisarDesvios).toHaveBeenCalledTimes(2);
    expect(m.avisarDesvios).toHaveBeenCalledWith({ tenantId: "tenant-a", porRegla: { doc_sin_recibir: 2 } });
    expect(m.avisarDesvios).toHaveBeenCalledWith({ tenantId: "tenant-b", porRegla: { plazo_vencido: 1 } });
    expect(await res.json()).toMatchObject({ desvios_nuevos: 3, avisos_de_desvios: 2 });
  });

  it("cuenta los correos que salieron, no las llamadas: un aviso sin destinatarios o con Gmail caído no suma", async () => {
    m.revisar.mockResolvedValue({
      nuevos: 3,
      porRegla: { doc_sin_recibir: 2, plazo_vencido: 1 },
      porInquilino: { "tenant-a": { doc_sin_recibir: 2 }, "tenant-b": { plazo_vencido: 1 } },
      fallidas: [],
    });
    m.avisarDesvios.mockResolvedValueOnce(false);

    const res = await GET(pedido());

    expect(m.avisarDesvios).toHaveBeenCalledTimes(2);
    expect(await res.json()).toMatchObject({ desvios_nuevos: 3, avisos_de_desvios: 1 });
  });

  it("sin desvíos nuevos no avisa a nadie", async () => {
    const res = await GET(pedido());

    expect(m.avisarDesvios).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ avisos_de_desvios: 0 });
  });

  it("sin cupo de revisión tampoco avisa: la revisión no corrió", async () => {
    m.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 900 });

    const res = await GET(pedido());

    expect(m.revisar).not.toHaveBeenCalled();
    expect(m.avisarDesvios).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ avisos_de_desvios: 0 });
  });

  it("deja de avisar cuando no queda un minuto de la función, y la purga corre igual", async () => {
    m.revisar.mockResolvedValue({
      nuevos: 2,
      porRegla: { plazo_vencido: 2 },
      porInquilino: { "tenant-a": { plazo_vencido: 1 }, "tenant-b": { plazo_vencido: 1 } },
      fallidas: [],
    });
    // El reloj pasa el margen después del primer aviso: el segundo inquilino no se avisa.
    m.avisarDesvios.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 300_000);
      return true;
    });

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(m.avisarDesvios).toHaveBeenCalledOnce();
    expect(m.avisarDesvios).toHaveBeenCalledWith({ tenantId: "tenant-a", porRegla: { plazo_vencido: 1 } });
    expect(m.purgar).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({ desvios_nuevos: 2, avisos_de_desvios: 1 });
  });

  it("si un aviso revienta no corta la purga y los conteos de la revisión se conservan", async () => {
    m.revisar.mockResolvedValue({
      nuevos: 1,
      porRegla: { plazo_vencido: 1 },
      porInquilino: { "tenant-a": { plazo_vencido: 1 } },
      fallidas: [],
    });
    m.avisarDesvios.mockRejectedValue(new Error("se cayó"));

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(m.purgar).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({ desvios_nuevos: 1, avisos_de_desvios: 0 });
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
      caseIds: [],
      retomados: 1,
      abandoned_closed: 4,
      recordatorios_enviados: 3,
      recordatorios_salteados: 1,
      avisos_de_cierre: 2,
      desvios_nuevos: 6,
      desvios_fallidas: [],
      avisos_de_desvios: 0,
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
    expect(m.purgaAdjuntos).toHaveBeenCalledWith({ hasta: hasta - 60_000 }, BASE_DE_CONTROL);
    expect(m.retencion).toHaveBeenCalledWith({ hasta: hasta - 60_000 }, expect.any(Date), BASE_DE_CONTROL);
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

describe("GET /api/cron/reap-stuck: una pasada por base (P10)", () => {
  const BASE_A = { base: "a" } as unknown as DbDueno;
  const BASE_B = { base: "b" } as unknown as DbDueno;

  // El recorrido de dos bases: cada barrido corre una vez en cada una.
  function conDosBases(extra: { pendientes?: number; fallas?: number } = {}) {
    m.paraCadaBase.mockImplementation(async (trabajo: Trabajo) => ({
      resultados: [await trabajo(BASE_A, "tenant-a"), await trabajo(BASE_B, "tenant-b")],
      pendientes: extra.pendientes ?? 0,
      fallas: extra.fallas ?? 0,
    }));
  }

  it("con la bandera apagada no relanza ni espeja, y la respuesta no trae `bases`", async () => {
    const res = await GET(pedido());

    expect(m.reintentar).not.toHaveBeenCalled();
    expect(m.espejar).not.toHaveBeenCalled();
    expect(await res.json()).not.toHaveProperty("bases");
  });

  it("cada barrido corre una vez por base, con la base que le toca", async () => {
    vi.stubEnv("BASE_POR_CLIENTE", "1");
    conDosBases();

    await GET(pedido());

    for (const barrido of [m.reap, m.retomar, m.recordar, m.cerrar, m.avisar, m.revisar]) {
      expect(barrido).toHaveBeenCalledTimes(2);
    }
    expect(m.reap).toHaveBeenNthCalledWith(1, undefined, BASE_A);
    expect(m.reap).toHaveBeenNthCalledWith(2, undefined, BASE_B);
    expect(m.retomar).toHaveBeenNthCalledWith(2, { hasta: expect.any(Number) }, BASE_B);
    expect(m.recordar).toHaveBeenNthCalledWith(1, { hasta: expect.any(Number) }, BASE_A);
    expect(m.cerrar).toHaveBeenNthCalledWith(2, BASE_B);
    expect(m.avisar).toHaveBeenNthCalledWith(1, { hasta: expect.any(Number) }, BASE_A);
    expect(m.revisar).toHaveBeenNthCalledWith(2, BASE_B);
  });

  it("junta lo de todas las bases en la respuesta", async () => {
    vi.stubEnv("BASE_POR_CLIENTE", "1");
    conDosBases();
    m.reap.mockImplementation(async (_o: unknown, db: DbDueno) =>
      db === BASE_A ? { reaped: 2, caseIds: ["a1", "a2"] } : { reaped: 1, caseIds: ["b1"] }
    );
    m.cerrar.mockImplementation(async (db: DbDueno) => ({ closed: db === BASE_A ? 4 : 5, caseIds: [] }));
    m.revisar.mockImplementation(async (db: DbDueno) =>
      db === BASE_A
        ? { nuevos: 2, porRegla: {}, porInquilino: { "tenant-a": { plazo_vencido: 2 } }, fallidas: ["plazo_vencido"] }
        : { nuevos: 1, porRegla: {}, porInquilino: { "tenant-b": { doc_sin_recibir: 1 } }, fallidas: ["plazo_vencido"] }
    );

    const res = await GET(pedido());

    expect(await res.json()).toMatchObject({
      reaped: 3,
      caseIds: ["a1", "a2", "b1"],
      abandoned_closed: 9,
      retomados: 2,
      recordatorios_enviados: 6,
      avisos_de_cierre: 4,
      desvios_nuevos: 3,
      desvios_fallidas: ["plazo_vencido"],
    });
    expect(m.avisarDesvios).toHaveBeenCalledWith({ tenantId: "tenant-a", porRegla: { plazo_vencido: 2 } });
    expect(m.avisarDesvios).toHaveBeenCalledWith({ tenantId: "tenant-b", porRegla: { doc_sin_recibir: 1 } });
  });

  it("la purga y la retención de la ventana también corren por base y se suman", async () => {
    vi.stubEnv("BASE_POR_CLIENTE", "1");
    vi.setSystemTime(EN_VENTANA);
    conDosBases();

    const res = await GET(pedido());

    const hasta = m.retomar.mock.calls[0][0].hasta;
    expect(m.purgaAdjuntos).toHaveBeenNthCalledWith(2, { hasta: hasta - 60_000 }, BASE_B);
    expect(m.retencion).toHaveBeenNthCalledWith(1, { hasta: hasta - 60_000 }, expect.any(Date), BASE_A);
    expect(await res.json()).toMatchObject({
      purga: { modo: "borrar", candidatos: 6, purgados: 4, fallidos: 2 },
      retencion: { modo: "borrar", anios: 5, inquilinos: 2, candidatos: 4, borrados: 4 },
    });
  });

  it("al final relanza las bases a medias y espeja, con lo que queda de la función, y lo informa", async () => {
    vi.stubEnv("BASE_POR_CLIENTE", "1");
    conDosBases({ pendientes: 3, fallas: 1 });
    m.reintentar.mockImplementation(anota("reintentar", { lanzadas: 2 }));
    m.espejar.mockImplementation(anota("espejar", { ok: 5, fallas: 1 }));

    const res = await GET(pedido());

    expect(m.orden.slice(-3)).toEqual(["purgar", "reintentar", "espejar"]);
    const hasta = m.retomar.mock.calls[0][0].hasta;
    expect(m.reintentar).toHaveBeenCalledWith(hasta - 15_000);
    expect(m.espejar).toHaveBeenCalledWith(hasta - 15_000);
    expect((await res.json()).bases).toMatchObject({ relanzadas: 2, espejadas: 5, espejo_fallas: 1, pendientes: 3 });
  });

  it("si una base falla el recorrido lo cuenta y la ruta sigue en 200", async () => {
    vi.stubEnv("BASE_POR_CLIENTE", "1");
    m.paraCadaBase.mockResolvedValue({ resultados: [], pendientes: 0, fallas: 1 });

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reaped: 0, retomados: 0, abandoned_closed: 0, bases: { fallas: 6 } });
  });
});

describe("GET /api/cron/reap-stuck: la salud de las WABAs propias", () => {
  it("corre en cada pasada, después de la purga y de las bases, y antes de contestar", async () => {
    vi.stubEnv("BASE_POR_CLIENTE", "1");
    m.purgar.mockImplementation(anota("purgar", 5));
    m.reintentar.mockImplementation(anota("reintentar", { lanzadas: 0 }));
    m.espejar.mockImplementation(anota("espejar", { ok: 0, fallas: 0 }));
    m.revisarWabas.mockImplementation(anota("revisarWabas", undefined));

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(m.revisarWabas).toHaveBeenCalledOnce();
    expect(m.orden.slice(-3)).toEqual(["reintentar", "espejar", "revisarWabas"]);
  });

  it("corre aunque la bandera de bases por cliente esté apagada", async () => {
    await GET(pedido());

    expect(m.revisarWabas).toHaveBeenCalledOnce();
  });

  it("si revienta la ruta contesta 200 igual y deja sólo el código en el log", async () => {
    const { logger } = await import("@/lib/observability/logger");
    m.revisarWabas.mockRejectedValue(new Error("token-de-la-waba"));

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, reaped: 2, rate_limit_rows_purged: 5 });
    expect(logger.error).toHaveBeenCalledWith(expect.any(Object), "cron_reap_stuck.waba_salud_fallo");
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("token-de-la-waba");
  });

  it("si lo anterior se comió el tiempo (quedan menos de 40 s) no la corre: pasarse de maxDuration corta la función", async () => {
    const { logger } = await import("@/lib/observability/logger");
    m.purgar.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 270_000);
      return 5;
    });

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect(m.revisarWabas).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith({}, "cron_reap_stuck.waba_salud_sin_tiempo");
  });

  it("con 40 s o más por delante sí la corre", async () => {
    m.purgar.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 250_000);
      return 5;
    });

    await GET(pedido());

    expect(m.revisarWabas).toHaveBeenCalledOnce();
  });

  it("sin el secreto del cron no revisa nada", async () => {
    const res = await GET(new NextRequest("http://localhost/api/cron/reap-stuck"));

    expect(res.status).toBe(401);
    expect(m.revisarWabas).not.toHaveBeenCalled();
  });
});
