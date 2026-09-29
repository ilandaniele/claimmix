/**
 * El barrido nocturno (B4): los recordatorios corren entre retomar y cerrar,
 * el aviso de cierre después del cierre, y si uno falla lo demás corre igual.
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
  purgar: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/intake/reap-stuck", () => ({ reapStuckProcessingCases: m.reap }));
vi.mock("@/server/intake/retomar-pendientes", () => ({ retomarExtraccionesPendientes: m.retomar }));
vi.mock("@/server/confirmations/recordatorios", () => ({ recordarPendientes: m.recordar, avisarCierres: m.avisar }));
vi.mock("@/server/intake/close-abandoned", () => ({ closeAbandonedConversations: m.cerrar }));
vi.mock("@/lib/rate-limit/postgres", () => ({ purgeExpiredRateLimits: m.purgar }));
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
  m.purgar.mockImplementation(anota("purgar", 5));
});

describe("GET /api/cron/reap-stuck", () => {
  it("corre reap, retomar, recordatorios, cierre, avisos de cierre y purga, en ese orden", async () => {
    await GET(pedido());
    expect(m.orden).toEqual(["reap", "retomar", "recordar", "cerrar", "avisar", "purgar"]);
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

  it("el JSON trae los recordatorios y los avisos, y conserva lo de antes", async () => {
    const res = await GET(pedido());

    expect(await res.json()).toEqual({
      ok: true,
      reaped: 2,
      retomados: 1,
      abandoned_closed: 4,
      recordatorios_enviados: 3,
      recordatorios_salteados: 1,
      avisos_de_cierre: 2,
      rate_limit_rows_purged: 5,
    });
  });
});
