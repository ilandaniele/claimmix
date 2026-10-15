/**
 * La reserva heredada no se pierde por una marca puesta de más.
 *
 * `acquireExtractionLease` hereda la reserva vencida sólo si `extraction_pending`
 * es false; con la marca puesta cae al paso 3, que la toma como «tomada», y el
 * orquestador contesta sin mirar si la corrida muerta ya había contestado.
 *
 * Dos escrituras ponían esa marca sin mirar la reserva: el freno del mail cuando
 * se vence el turno, y el redespacho que no llegó. Los dos caminos son carreras
 * que el ensayo no puede forzar, así que se prueba qué WHERE llevan.
 */

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { RESERVA_DE_EXTRACCION_MS } from "@/core/case/reserva-de-extraccion";
import { filaDeCaso, registrarMocks } from "./worker-harness";

vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "aaaaaaaa-0000-4000-8000-000000000011";
const TENANT_ID = "bbbbbbbb-0000-4000-8000-000000000012";
const AHORA = Date.parse("2026-10-07T12:00:00.000Z");
const dialecto = new PgDialect();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Corre el worker con el reloj quieto. `freno` vence el turno del mail;
 * `pendienteAlSoltar` hace que al soltar la reserva aparezca la marca, y con ella
 * el redespacho, cuyo POST contesta `respuesta` (o tira, si es un `Error`).
 */
async function correr({
  freno = false,
  pendienteAlSoltar = false,
  respuesta = { ok: false, status: 401 },
}: {
  freno?: boolean;
  pendienteAlSoltar?: boolean;
  respuesta?: { ok: boolean; status: number } | Error;
} = {}) {
  vi.resetModules();
  // Con el reloj quieto `arrancó` es fijo y le quedan los 40 s enteros al redespacho.
  vi.spyOn(Date, "now").mockReturnValue(AHORA);
  vi.stubEnv("CRON_SECRET", "test-cron-secret-key");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://fake-app.example.com");

  const fetch = vi.fn();
  if (respuesta instanceof Error) fetch.mockRejectedValue(respuesta);
  else fetch.mockResolvedValue(respuesta);
  vi.stubGlobal("fetch", fetch);

  vi.doMock("@/server/intake/simulation-throttle", () => ({
    waitForEmailExtractionTurn: vi
      .fn()
      .mockResolvedValue({ waitedMs: 20_000, timedOut: freno, blockers: freno ? 1 : 0 }),
  }));

  const espiaDeUpdate: Mock<(data: Record<string, unknown>) => void> = vi.fn();
  const espiaDeFiltro: Mock<(data: Record<string, unknown>, filtro: unknown) => void> = vi.fn();
  registrarMocks({ fila: filaDeCaso(CASE_ID, TENANT_ID), espiaDeUpdate, espiaDeFiltro, pendienteAlSoltar });

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  // Las escrituras que sólo ponen la marca: son las que no deben pisar una reserva ajena.
  const marcas = espiaDeFiltro.mock.calls
    .filter(([data]) => Object.keys(data).length === 1 && data.extraction_pending === true)
    .map(([, filtro]) => dialecto.sqlToQuery(filtro as SQL));
  const escrito = espiaDeUpdate.mock.calls.map((c) => c[0]);
  return { marcas, escrito, fetch };
}

describe("el freno del mail no le borra la heredada a nadie", () => {
  it("al vencer el turno marca pendiente sólo sin reserva o con una viva al arrancar", async () => {
    const { marcas } = await correr({ freno: true });
    expect(marcas).toHaveLength(1);
    expect(marcas[0].sql).toContain('"cases"."extraction_lease_at" is null');
    expect(marcas[0].sql).toContain(" or ");
    expect(marcas[0].sql).toContain('"cases"."extraction_lease_at" >= $');
    // Viva = tomada hace menos que la reserva, contada desde que arrancó la corrida.
    expect(marcas[0].params.map((p) => Date.parse(String(p)))).toContain(AHORA - RESERVA_DE_EXTRACCION_MS);
  });

  it("y vuelve sin tomar la reserva", async () => {
    const { escrito, fetch } = await correr({ freno: true });
    expect(escrito.some((data) => "extraction_lease_at" in data)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("con turno, lo primero que escribe es la reserva y no la marca", async () => {
    // El control: la marca del freno no se escribe cuando el turno llega.
    const { escrito, marcas } = await correr();
    expect(escrito[0]).toEqual(expect.objectContaining({ extraction_lease_at: expect.any(String) }));
    expect(marcas).toHaveLength(0);
  });
});

describe("el redespacho que no llegó no marca la reserva de otra corrida", () => {
  it("si el POST no llega, marca sólo si nadie la tomó", async () => {
    const { marcas, fetch } = await correr({ pendienteAlSoltar: true });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/worker/extract"), expect.anything());
    expect(marcas).toHaveLength(1);
    expect(marcas[0].sql).toContain('"cases"."extraction_lease_at" is null');
    expect(marcas[0].sql).not.toContain(">=");
    expect(marcas[0].sql).not.toContain(" or ");
  });

  it("y tampoco si el pedido tira", async () => {
    const { marcas } = await correr({ pendienteAlSoltar: true, respuesta: new TypeError("fetch failed") });
    expect(marcas).toHaveLength(1);
    expect(marcas[0].sql).toContain('"cases"."extraction_lease_at" is null');
    expect(marcas[0].sql).not.toContain(">=");
    expect(marcas[0].sql).not.toContain(" or ");
  });

  it("si el POST llega (200), no marca nada", async () => {
    const { marcas, fetch } = await correr({ pendienteAlSoltar: true, respuesta: { ok: true, status: 200 } });
    expect(fetch).toHaveBeenCalled();
    expect(marcas).toHaveLength(0);
  });

  it("sin nada nuevo al soltar, no redespacha ni marca", async () => {
    const { marcas, fetch } = await correr();
    expect(fetch).not.toHaveBeenCalled();
    expect(marcas).toHaveLength(0);
  });
});
