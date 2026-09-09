/**
 * La corrida que se quedó sin tiempo se va ordenada.
 *
 * La función tiene 60 s y cuando se acaban no hay aviso: el proceso se corta
 * donde esté. Una extracción tarda 10-20 s, así que sola no llega — pero antes
 * de ella se bajaron los adjuntos (hasta cuatro, 10 s cada uno) y después puede
 * venir un redespacho, que corre otra corrida ENTERA adentro de esta misma
 * invocación.
 *
 * Cuando la matan a mitad de la fase (e) ya hay campos escritos y estado sin
 * actualizar, y nadie lo cuenta porque no queda proceso que lo cuente.
 */

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { filaDeCaso, registrarMocks } from "./worker-harness";

vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const TENANT_ID = "bbbbbbbb-0000-4000-8000-000000000002";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Corre el worker con un reloj que salta `saltoMs` durante el control de
 * presupuesto — la fase justo anterior a la llamada al modelo.
 */
async function correrConSalto(saltoMs: number) {
  vi.resetModules();

  const espiaDeUpdate: Mock<(data: Record<string, unknown>) => void> = vi.fn();
  registrarMocks({ fila: filaDeCaso(CASE_ID, TENANT_ID), espiaDeUpdate });

  let reloj = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => reloj);

  vi.doMock("@/server/ai/budget", () => ({
    checkBudget: vi.fn().mockImplementation(async () => {
      reloj += saltoMs;
      return { exceeded: false };
    }),
    recordUsage: vi.fn().mockResolvedValue(undefined),
  }));

  const extractor = vi.fn().mockResolvedValue({
    is_claim: true,
    confidence: 0.9,
    fields: [],
    extracted_fields: {},
    missing_fields: [],
    fields_pending_confirmation: [],
    possible_customer_matches: [],
    possible_policy_matches: [],
    severity: "medium",
    requires_specialist: false,
    summary: "",
    suggested_reply: "",
  });
  vi.doMock("@/server/ai/claim-agent", () => ({
    runEmailClaimAgent: extractor,
    runClaimTextAgent: extractor,
    ClaimAgentError: class extends Error {},
  }));

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  const escrito = espiaDeUpdate.mock.calls.map((c) => c[0]);
  return { extractor, escrito };
}

describe("el reloj de la corrida", () => {
  it("sin tiempo, no llama al modelo", async () => {
    const { extractor } = await correrConSalto(41_000);
    expect(extractor).not.toHaveBeenCalled();
  });

  it("y deja el caso marcado para que lo tome la próxima", async () => {
    // La misma marca que usa el mensaje que llega a mitad de corrida. No hay
    // dos formas de decir «volvé por este caso», y no hace falta una segunda.
    const { escrito } = await correrConSalto(41_000);
    expect(escrito).toContainEqual(
      expect.objectContaining({ extraction_pending: true })
    );
  });

  it("con tiempo de sobra corre como siempre", async () => {
    // El control. Sin esto, un presupuesto mal puesto —o el chequeo del lado
    // equivocado del `if`— apaga la extracción entera y los dos tests de arriba
    // siguen en verde.
    const { extractor } = await correrConSalto(1_000);
    expect(extractor).toHaveBeenCalledTimes(1);
  });
});
