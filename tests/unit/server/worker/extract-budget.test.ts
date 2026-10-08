/**
 * El worker con el presupuesto agotado: escala el caso y, si el tope es de los
 * que dejan sin analizar a todos, le avisa al equipo.
 *
 * El cupo de una persona no frena al canal, así que ése no avisa: un solo
 * usuario pasado de su cupo no es un incidente de la aseguradora.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { filaDeCaso, registrarMocks, statusEscrito } from "./worker-harness";

// Cada caso reimporta el grafo entero del worker: ver extract.overlay.test.ts.
vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "budget-test-0000-0000-000000000001";
const TENANT_ID = "budget-test-0000-0000-000000000002";

afterEach(() => {
  vi.restoreAllMocks();
});

async function correr(presupuesto: Record<string, unknown>, casoMovido = false) {
  vi.resetModules();

  const espiaDeUpdate = vi.fn();
  const { espiaDeAuditoria } = registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID, { channel: "email" }),
    espiaDeUpdate,
    casoMovido,
  });

  const aviso = vi.fn().mockResolvedValue(undefined);
  vi.doMock("@/server/ai/budget", () => ({
    checkBudget: vi.fn().mockResolvedValue(presupuesto),
    recordUsage: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("@/server/notify/specialist-alert", () => ({ avisarPresupuestoAgotado: aviso }));

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  return { aviso, espiaDeUpdate, espiaDeAuditoria };
}

/** El orden global de la llamada que escribió `status: "escalado"`. */
function ordenDelEscalado(espiaDeUpdate: ReturnType<typeof vi.fn>) {
  const i = espiaDeUpdate.mock.calls.findIndex((c) => (c[0] as Record<string, unknown>)?.status === "escalado");
  return i >= 0 ? espiaDeUpdate.mock.invocationCallOrder[i] : undefined;
}

describe("runEmailExtractionWorker — presupuesto agotado", () => {
  it.each(["mensual", "inquilino", "anonimo"] as const)("agotado por «%s» avisa al equipo con ese motivo", async (motivo) => {
    const { aviso } = await correr({ exceeded: true, reason: "tope", motivo });

    expect(aviso).toHaveBeenCalledTimes(1);
    expect(aviso).toHaveBeenCalledWith({ tenantId: TENANT_ID, motivo });
  });

  it("avisa antes de escalar el caso, y el caso queda escalado", async () => {
    const { aviso, espiaDeUpdate } = await correr({ exceeded: true, reason: "tope", motivo: "inquilino" });

    expect(statusEscrito(espiaDeUpdate)).toBe("escalado");
    expect(aviso.mock.invocationCallOrder[0]).toBeLessThan(ordenDelEscalado(espiaDeUpdate)!);
  });

  it("agotado por el cupo de una persona no avisa, pero escala igual", async () => {
    const { aviso, espiaDeUpdate } = await correr({ exceeded: true, reason: "tope", motivo: "persona" });

    expect(aviso).not.toHaveBeenCalled();
    expect(statusEscrito(espiaDeUpdate)).toBe("escalado");
  });

  it("un tope sin motivo (un mock viejo) no avisa y tampoco rompe", async () => {
    const { aviso, espiaDeUpdate } = await correr({ exceeded: true, reason: "monthly_cap" });

    expect(aviso).not.toHaveBeenCalled();
    expect(statusEscrito(espiaDeUpdate)).toBe("escalado");
  });

  it("con presupuesto no avisa ni escala", async () => {
    const { aviso, espiaDeUpdate } = await correr({ exceeded: false });

    expect(aviso).not.toHaveBeenCalled();
    expect(statusEscrito(espiaDeUpdate)).not.toBe("escalado");
  });

  it("la auditoría de lo excedido sigue siendo una por mensaje", async () => {
    const { espiaDeAuditoria } = await correr({ exceeded: true, reason: "tope", motivo: "anonimo" });

    const excedidos = espiaDeAuditoria.mock.calls.filter((c) => c[0].event_type === "ai.budget_exceeded");
    expect(excedidos).toHaveLength(1);
    expect(excedidos[0][0]).toMatchObject({ tenant_id: TENANT_ID, target_id: CASE_ID, payload: { reason: "tope" } });
  });

  // Ese evento alimenta la regla de derivación y las métricas del trayecto:
  // sin él, el cambio a escalado no tiene quién lo cuente.
  it("el escalado deja un ai.extracted con el cambio de estado y el motivo", async () => {
    const { espiaDeAuditoria } = await correr({ exceeded: true, reason: "tope", motivo: "anonimo" });

    const escalados = espiaDeAuditoria.mock.calls.filter((c) => c[0].event_type === "ai.extracted");
    expect(escalados).toHaveLength(1);
    expect(escalados[0][0]).toMatchObject({
      tenant_id: TENANT_ID,
      target_id: CASE_ID,
      payload: { new_status: "escalado", reason: "budget_exceeded", error_code: "AI_BUDGET_EXCEEDED" },
    });
    expect(escalados[0][0].payload).not.toHaveProperty("status_not_applied");
  });

  it("si otra mano ya movió el caso, el ai.extracted avisa que el estado no se aplicó", async () => {
    const { espiaDeAuditoria } = await correr({ exceeded: true, reason: "tope", motivo: "anonimo" }, true);

    const escalados = espiaDeAuditoria.mock.calls.filter((c) => c[0].event_type === "ai.extracted");
    expect(escalados).toHaveLength(1);
    expect(escalados[0][0].payload).toMatchObject({ new_status: "escalado", status_not_applied: true });
  });
});
