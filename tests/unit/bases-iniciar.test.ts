/**
 * `iniciarBase`: deja la fila en `creando` y lanza el flujo que prepara la base.
 *
 * Apagada la bandera no hace nada. Encendida, registra ANTES de lanzar: si el
 * lanzamiento falla, la fila ya está y /preparando sabe qué mostrar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ registrarBase: vi.fn(), start: vi.fn(), prepararBase: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("workflow/api", () => ({ start: h.start }));
vi.mock("@/server/bases/crear-base", () => ({ registrarBase: h.registrarBase }));
vi.mock("@/workflows/preparar-base", () => ({ prepararBase: h.prepararBase }));

import { iniciarBase } from "@/server/bases/iniciar";

const TENANT = "aaaaaaaa-0000-4000-8000-00000000000a";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BASE_POR_CLIENTE;
  h.registrarBase.mockResolvedValue(undefined);
  h.start.mockResolvedValue({ runId: "run-1" });
});

describe("iniciarBase", () => {
  it("apagada la bandera no registra ni lanza nada", async () => {
    await iniciarBase(TENANT);

    expect(h.registrarBase).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each(["0", "", "true"])("BASE_POR_CLIENTE=%j tampoco la enciende", async (valor) => {
    process.env.BASE_POR_CLIENTE = valor;

    await iniciarBase(TENANT);

    expect(h.start).not.toHaveBeenCalled();
  });

  it("encendida registra el inquilino y lanza `prepararBase` con su id", async () => {
    process.env.BASE_POR_CLIENTE = "1";

    await iniciarBase(TENANT);

    expect(h.registrarBase).toHaveBeenCalledWith(TENANT);
    expect(h.start).toHaveBeenCalledWith(h.prepararBase, [TENANT]);
  });

  it("registra antes de lanzar", async () => {
    process.env.BASE_POR_CLIENTE = "1";

    await iniciarBase(TENANT);

    expect(h.registrarBase.mock.invocationCallOrder[0]).toBeLessThan(h.start.mock.invocationCallOrder[0]);
  });

  it("si no puede registrar, no lanza y la falla sube", async () => {
    process.env.BASE_POR_CLIENTE = "1";
    h.registrarBase.mockRejectedValue(new Error("sin base"));

    await expect(iniciarBase(TENANT)).rejects.toThrow("sin base");
    expect(h.start).not.toHaveBeenCalled();
  });

  it("si el lanzamiento falla, la falla sube (la fila ya quedó registrada)", async () => {
    process.env.BASE_POR_CLIENTE = "1";
    h.start.mockRejectedValue(new Error("sin cola"));

    await expect(iniciarBase(TENANT)).rejects.toThrow("sin cola");
    expect(h.registrarBase).toHaveBeenCalledTimes(1);
  });
});
