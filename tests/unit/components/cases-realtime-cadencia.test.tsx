/**
 * Cada cuánto la bandeja le pregunta a la base.
 *
 * El defecto que fija este archivo no se ve mirando la pantalla: costaba tres
 * viajes a la base cada cinco segundos, para siempre, en cada pestaña abierta
 * —uno de ellos una escritura— y se comía doce de los cien pedidos por minuto
 * del cupo sin que nadie tocara nada. Se arregla esperando más cuando no pasa
 * nada, y volviendo a la espera corta en cuanto pasa algo.
 *
 * Los números están acá a propósito: si alguien vuelve a poner un `setInterval`
 * fijo, esto se pone rojo.
 */

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCasesRealtime } from "../../../src/app/(app)/bandeja/components/useCasesRealtime";
import type { CaseRow } from "../../../src/server/cases/list";

function caso(id: string, status = "recibido"): CaseRow {
  return {
    id,
    tenant_id: "t1",
    policy_number: "POL-1",
    policyholder_name: "Juan Pérez",
    claim_type: "choque",
    status,
    confidence_min: 0.9,
    assigned_to: null,
    channel: "email_sim",
    created_at: "2026-09-06T00:00:00.000Z",
    updated_at: null,
    closed_at: null,
  } as unknown as CaseRow;
}

/** Lo que va a devolver el próximo fetch. */
let filas: CaseRow[] = [];
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  filas = [caso("a")];
  fetchSpy = vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: filas }),
  }));
  vi.stubGlobal("fetch", fetchSpy);
  // jsdom arranca la pestaña visible, pero dejarlo escrito evita que un cambio
  // de entorno apague el sondeo y el test pase por no pedir nada.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const manos = { onInsert: vi.fn(), onUpdate: vi.fn() };

describe("useCasesRealtime — cada cuánto pregunta", () => {
  it("sin novedades, la espera se duplica hasta medio minuto y ahí se queda", async () => {
    renderHook(() => useCasesRealtime(manos));
    await vi.advanceTimersByTimeAsync(0); // el sondeo que siembra la base
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 5 s, después 10, 20 y 30. A los 30 toca el techo y no crece más.
    for (const espera of [5000, 10000, 20000, 30000, 30000]) {
      const antes = fetchSpy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(espera - 1);
      expect(fetchSpy).toHaveBeenCalledTimes(antes);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchSpy).toHaveBeenCalledTimes(antes + 1);
    }
  });

  it("una bandeja quieta pide seis veces menos en dos minutos", async () => {
    renderHook(() => useCasesRealtime(manos));
    await vi.advanceTimersByTimeAsync(120_000);
    // Con la espera fija de cinco segundos eran 24 pedidos por minuto de pantalla
    // abierta; con el retroceso son ocho en dos minutos.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("apenas aparece un caso nuevo, vuelve a preguntar cada cinco segundos", async () => {
    renderHook(() => useCasesRealtime(manos));
    await vi.advanceTimersByTimeAsync(0);

    // Se deja crecer la espera: 5 + 10 + 20 sin novedades.
    await vi.advanceTimersByTimeAsync(35_000);

    // Entra un caso: el próximo sondeo lo ve y la espera vuelve a la corta.
    filas = [caso("a"), caso("b")];
    await vi.advanceTimersByTimeAsync(30_000);

    const antes = fetchSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchSpy).toHaveBeenCalledTimes(antes);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(antes + 1);
  });

  it("al desmontar no queda ningún temporizador pidiendo", async () => {
    const { unmount } = renderHook(() => useCasesRealtime(manos));
    await vi.advanceTimersByTimeAsync(0);
    unmount();
    const antes = fetchSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchSpy).toHaveBeenCalledTimes(antes);
  });
});
