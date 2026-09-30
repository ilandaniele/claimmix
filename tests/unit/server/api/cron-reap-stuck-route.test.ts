/**
 * El barrido nocturno (B4, B22): los recordatorios corren entre retomar y
 * cerrar, el aviso de cierre después del cierre, la revisión de desvíos al
 * final de los barridos de casos, y si uno falla lo demás corre igual.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
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
  rateLimit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/intake/reap-stuck", () => ({ reapStuckProcessingCases: m.reap }));
vi.mock("@/server/intake/retomar-pendientes", () => ({ retomarExtraccionesPendientes: m.retomar }));
vi.mock("@/server/confirmations/recordatorios", () => ({ recordarPendientes: m.recordar, avisarCierres: m.avisar }));
vi.mock("@/server/intake/close-abandoned", () => ({ closeAbandonedConversations: m.cerrar }));
vi.mock("@/server/desvios/revision-nocturna", () => ({ revisarDesvios: m.revisar }));
vi.mock("@/lib/rate-limit/postgres", () => ({ purgeExpiredRateLimits: m.purgar }));
vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: m.rateLimit,
  RATE_LIMIT_CONFIGS: { REVISION_DE_DESVIOS: { limit: 1, windowMs: 86_400_000 } },
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { GET } from "@/app/api/cron/reap-stuck/route";

const SECRETO = "secreto-de-prueba";
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
  m.orden.length = 0;
  vi.stubEnv("CRON_SECRET", SECRETO);
  m.reap.mockImplementation(anota("reap", { reaped: 2 }));
  m.retomar.mockImplementation(anota("retomar", { retomados: 1 }));
  m.recordar.mockImplementation(anota("recordar", { enviados: 3, salteados: 1 }));
  m.cerrar.mockImplementation(anota("cerrar", { closed: 4, caseIds: [] }));
  m.avisar.mockImplementation(anota("avisar", 2));
  m.revisar.mockImplementation(anota("revisar", { nuevos: 6, porRegla: {} }));
  m.purgar.mockImplementation(anota("purgar", 5));
  m.rateLimit.mockResolvedValue({ allowed: true, remaining: 0, retryAfterSeconds: 0 });
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
      rate_limit_rows_purged: 5,
    });
  });
});
