/**
 * F2: el worker y el orquestador comparten la misma severidad final, y toda
 * lesión declarada deriva a un especialista aunque la severidad no lo pida.
 *
 * La única escritura de auditoría de la derivación vive en `escalate()`
 * (`@/server/confirmations/orchestrate`), no acá: el worker sólo le pasa la
 * severidad y `requires_specialist` ya resueltos.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { filaDeCaso, registrarMocks, statusEscrito } from "./worker-harness";

vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "derivacion-test-000-0000-000000000001";
const TENANT_ID = "derivacion-test-000-0000-000000000002";

afterEach(() => {
  vi.restoreAllMocks();
});

async function correr(opciones: {
  necesitaEspecialista?: boolean;
  severity?: string;
  injury_severity?: string;
  cuerpo?: string;
}) {
  vi.resetModules();

  const espiaDeUpdate = vi.fn();
  const espiaDeAuditoria = vi.fn().mockResolvedValue(undefined);
  registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID),
    espiaDeUpdate,
    espiaDeAuditoria,
    necesitaEspecialista: opciones.necesitaEspecialista ?? false,
    extractor: {
      severity: opciones.severity,
      injury_severity: opciones.injury_severity,
    },
    cuerpo: opciones.cuerpo,
  });

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  const { orchestratePostExtraction } = await import("@/server/confirmations/orchestrate");
  const llamadas = vi.mocked(orchestratePostExtraction).mock.calls;
  expect(llamadas).toHaveLength(1);

  return {
    claim: llamadas[0][2].extractedClaim,
    status: statusEscrito(espiaDeUpdate),
    eventosDeAuditoria: espiaDeAuditoria.mock.calls.map((c) => c[0]?.event_type),
  };
}

describe("runEmailExtractionWorker — severidad y derivación compartidas (F2)", () => {
  it("severidad alta: el worker no escribe la auditoría de derivación, y el orquestador recibe la severidad final", async () => {
    const { claim, eventosDeAuditoria } = await correr({
      necesitaEspecialista: true,
      severity: "medium",
    });

    expect(claim.severity).toBe("high");
    expect(claim.requires_specialist).toBe(true);
    expect(eventosDeAuditoria).not.toContain("claim.specialist_required");
  });

  it("una lesión declarada deriva aunque la severidad sea baja", async () => {
    const { claim, status } = await correr({
      injury_severity: "minor",
      cuerpo: "Me fracturé la muñeca al caerme de la moto.",
    });

    expect(claim.requires_specialist).toBe(true);
    expect(status).toBe("requiere_especialista");
  });

  it("sin heridos y con severidad media, no deriva", async () => {
    const { claim, status } = await correr({});

    expect(claim.requires_specialist).toBe(false);
    expect(status).not.toBe("requiere_especialista");
  });
});
