/**
 * Encolar la retoma nunca puede tirar fuera del worker.
 *
 * El worker llama a `programarRetoma` en el `finally`, después de soltar la
 * reserva. Si `start()` fallara hacia afuera, una falla pasajera del modelo se
 * volvería un error del worker, y el caso quedaría igual que antes del flujo:
 * marca puesta y a la espera del barrido. Lo que se prueba acá es que el único
 * efecto de un `start()` caído es un aviso.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  start: vi.fn(),
  flujo: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("workflow/api", () => ({ start: h.start }));
vi.mock("@/workflows/retomar-tras-corte", () => ({ retomarTrasCorte: h.flujo }));

import { programarRetoma } from "@/server/intake/programar-retoma";

beforeEach(() => {
  vi.clearAllMocks();
  h.start.mockResolvedValue({ runId: "wrun_123" });
});

describe("programarRetoma", () => {
  it("arranca el flujo con el caso y el inquilino, y lo anota con el id de la corrida", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await programarRetoma("caso-1", "t-1");

    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledWith(h.flujo, [{ caseId: "caso-1", tenantId: "t-1" }]);
    const anotado = JSON.parse(info.mock.calls[0][0] as string);
    expect(anotado.msg).toBe("retomar_pendientes.retoma_programada");
    expect(anotado.case_id).toBe("caso-1");
    expect(anotado.run_id).toBe("wrun_123");
  });

  it("si start() falla, no tira y lo dice con el nombre del error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.start.mockRejectedValue(new TypeError("invalid workflow function"));

    await expect(programarRetoma("caso-1", "t-1")).resolves.toBeUndefined();

    const anotado = JSON.parse(warn.mock.calls[0][0] as string);
    expect(anotado.msg).toBe("retomar_pendientes.retoma_no_programada");
    expect(anotado.case_id).toBe("caso-1");
    expect(anotado.error_name).toBe("TypeError");
    // El mensaje del error no sale: puede traer lo que sea.
    expect(JSON.stringify(anotado)).not.toContain("invalid workflow function");
  });

  it("un error que no es un Error también se traga", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.start.mockRejectedValue("se cayó");

    await expect(programarRetoma("caso-1", "t-1")).resolves.toBeUndefined();

    expect(JSON.parse(warn.mock.calls[0][0] as string).error_name).toBe("UnknownError");
  });
});
