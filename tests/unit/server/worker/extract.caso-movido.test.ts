/**
 * E2: el worker no pisa un caso que otra mano ya movió.
 *
 * El `UPDATE ... WHERE status = <el que vio> RETURNING` es la guarda: si otra
 * corrida, un analista o `devolver-al-agente` cambiaron el estado entre la
 * lectura y la escritura, la fila no matchea y vuelve `[]`. Acá se prueba que
 * ese `[]` corta el paso: nunca llega a `orchestratePostExtraction`, que
 * mandaría mails y auditoría sobre una extracción que no quedó escrita.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { filaDeCaso, registrarMocks } from "./worker-harness";

vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "casomovido-000-0000-0000-000000000001";
const TENANT_ID = "casomovido-000-0000-0000-000000000002";

afterEach(() => {
  vi.restoreAllMocks();
});

async function correr(casoMovido: boolean) {
  vi.resetModules();

  const espiaDeUpdate = vi.fn();
  registrarMocks({
    fila: filaDeCaso(CASE_ID, TENANT_ID),
    espiaDeUpdate,
    casoMovido,
  });

  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

  const { orchestratePostExtraction } = await import("@/server/confirmations/orchestrate");

  return {
    llamadasAlOrquestador: vi.mocked(orchestratePostExtraction).mock.calls.length,
    seIntentoEscribir: espiaDeUpdate.mock.calls.some(
      (c) => (c[0] as Record<string, unknown>).status === "listo"
    ),
  };
}

describe("runEmailExtractionWorker — el caso sigue siendo del agente (E2)", () => {
  it("con el caso donde lo dejó, escribe y llama al orquestador", async () => {
    const { llamadasAlOrquestador, seIntentoEscribir } = await correr(false);

    expect(seIntentoEscribir).toBe(true);
    expect(llamadasAlOrquestador).toBe(1);
  });

  it("con el caso ya movido, intenta escribir pero no llega al orquestador", async () => {
    const { llamadasAlOrquestador, seIntentoEscribir } = await correr(true);

    // El intento de escritura sale igual: lo que corta el paso es la guarda
    // del UPDATE, no que el worker se haya dado cuenta antes.
    expect(seIntentoEscribir).toBe(true);
    expect(llamadasAlOrquestador).toBe(0);
  });
});
