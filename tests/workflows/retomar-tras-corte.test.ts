/**
 * ¿El flujo de la retoma se compila, se registra y se suspende?
 *
 * Con el compilador de flujos puesto, `start()` encola una corrida de verdad:
 * esto prueba que el build lo reconoce, que lo arranca por el nombre con que
 * lo busca `programarRetoma` y que se queda esperando los 45 s en vez de
 * retomar de inmediato.
 *
 * No espera el despertar ni corre el paso: el paso toca la base, y acá no hay.
 * La corrida se cancela apenas queda suspendida. Qué hace el paso lo prueba
 * `tests/unit/workflows-retomar-tras-corte.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { start, getRun } from "workflow/api";
import { getWorkflowRef, waitForSleep } from "@workflow/vitest";

describe("el flujo de la retoma tras un corte", () => {
  it("arranca y queda esperando antes de retomar", async () => {
    const run = await start(getWorkflowRef("retomarTrasCorte"), [
      { caseId: "caso-1", tenantId: "00000000-0000-0000-0000-000000000001" },
    ]);

    try {
      expect(run.runId).toMatch(/^wrun_/);
      // Si retomara sin esperar, nunca habría una espera pendiente.
      await expect(waitForSleep(run)).resolves.toEqual(expect.any(String));
      expect(await run.status).toBe("running");
    } finally {
      await getRun(run.runId).cancel();
    }
  });
});
