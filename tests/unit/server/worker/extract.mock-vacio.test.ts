/**
 * E16, del lado del worker: MOCK_AI deriva a especialista, no inventa nada.
 *
 * El harness (`registrarMocks`) mockea `@/server/ai/mock-extractor` entero
 * para poder pisar `extractEmailClaimMock` desde `extractor` — eso es lo que
 * usan los demás archivos de esta carpeta. Acá se pisa esa mock de nuevo,
 * DESPUÉS de `registrarMocks`, con el módulo real: es la única manera de
 * probar `denunciaSimuladaVacia()` de verdad y no una versión que la reemplaza.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { filaDeCaso, registrarMocks } from "./worker-harness";

vi.setConfig({ testTimeout: 30_000 });

const CASE_ID = "mockvacio-000-0000-0000-000000000001";
const TENANT_ID = "mockvacio-000-0000-0000-000000000002";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runEmailExtractionWorker en modo mock — sin denuncia inventada", () => {
  it("deja el caso en requiere_especialista y no escribe nada de la denuncia fija", async () => {
    vi.resetModules();

    const espiaDeUpdate = vi.fn();
    registrarMocks({
      fila: filaDeCaso(CASE_ID, TENANT_ID),
      espiaDeUpdate,
    });

    // Se pisa DESPUÉS de registrarMocks: el módulo real, no la denuncia fija
    // que arma esa función para los demás tests de esta carpeta.
    vi.doMock("@/server/ai/mock-extractor", (importOriginal) =>
      importOriginal<typeof import("@/server/ai/mock-extractor")>()
    );

    const { runEmailExtractionWorker } = await import("@/server/worker/extract");
    await runEmailExtractionWorker(CASE_ID, TENANT_ID, null);

    const statusEscrito = espiaDeUpdate.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((p) => p && "status" in p)
      .at(-1)?.status;
    expect(statusEscrito).toBe("requiere_especialista");

    for (const [payload] of espiaDeUpdate.mock.calls) {
      expect((payload as Record<string, unknown>).policy_number).not.toBe("POL-1234");
      expect((payload as Record<string, unknown>).policyholder_name).not.toBe("Juan Pérez");
    }
  });
});
