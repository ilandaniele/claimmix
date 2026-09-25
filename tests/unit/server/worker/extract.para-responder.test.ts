/**
 * Lo que entra mientras el worker corre.
 *
 * El ingreso no lo marca porque el caso todavía no terminó, y el re-despacho
 * cae en un estado del que el worker no arranca: sin esto, el mensaje quedaba
 * sin leer y sin marcar. La corrida, al terminar, marca el caso si hay un
 * entrante que no leyó (el SQL de esa condición se prueba en
 * `tests/unit/server/cases/para-responder.test.ts`).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { filaDeCaso, registrarMocks, type Conversacion } from "./worker-harness";

// Cada caso reimporta el grafo entero del worker: ver extract.overlay.test.ts.
vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "pararesp-test-0000-0000-000000000001";
const TENANT_ID = "pararesp-test-0000-0000-000000000002";

afterEach(() => {
  vi.restoreAllMocks();
});

async function correr(conversacion?: Conversacion["conversacion"], falla = false) {
  vi.resetModules();
  registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID, { channel: "whatsapp" }),
    espiaDeUpdate: vi.fn(),
    conversacion,
  });
  const marcar = falla ? vi.fn().mockRejectedValue(new Error("neon")) : vi.fn().mockResolvedValue(undefined);
  vi.doMock("@/server/cases/para-responder", () => ({ marcarParaResponder: marcar }));

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);
  const { orchestratePostExtraction } = await import("@/server/confirmations/orchestrate");
  return { marcar, orquestar: vi.mocked(orchestratePostExtraction) };
}

describe("el worker y «Para responder»", () => {
  it("al terminar, marca con los entrantes que leyó", async () => {
    const { marcar, orquestar } = await correr({
      enviado: "2026-09-25T10:00:00.000Z",
      mensajes: [
        ["Choqué en Alem", "2026-09-25T10:01:00.000Z"],
        ["Mando la foto", "2026-09-25T10:02:00.000Z"],
      ],
    });

    expect(marcar).toHaveBeenCalledWith(CASE_ID, TENANT_ID, {
      sinLeer: ["entrante-1", "entrante-2"],
    });
    // Después de que el orquestador dejó el estado final: antes, el caso
    // todavía no está terminado y la marca no aplica.
    expect(orquestar).toHaveBeenCalledTimes(1);
    expect(marcar.mock.invocationCallOrder[0]).toBeGreaterThan(
      orquestar.mock.invocationCallOrder[0]
    );
  });

  it("sin conversación que leer, no marca", async () => {
    const { marcar } = await correr();

    expect(marcar).not.toHaveBeenCalled();
  });

  it("si marcar falla, la corrida termina igual", async () => {
    const { marcar } = await correr(
      { enviado: "2026-09-25T10:00:00.000Z", mensajes: [["Hola", "2026-09-25T10:01:00.000Z"]] },
      true
    );

    expect(marcar).toHaveBeenCalledTimes(1);
  });
});
