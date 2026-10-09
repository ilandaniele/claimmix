/**
 * `baseLista`: ¿ya tiene su base lista quien tiene la sesión? Es lo que miran
 * conectar Gmail y las acciones del número para saber si mandar a /preparando.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  fila: vi.fn(),
  olvidar: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/fila-de-usuario-cacheada", () => ({
  filaDeUsuario: h.fila,
  olvidarFilaDeUsuario: h.olvidar,
}));

import { baseLista } from "@/server/bases/base-lista";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BASE_POR_CLIENTE = "1";
  h.fila.mockResolvedValue({ id: "u-1", tenant_id: "t-1", role: "owner", base: "lista", baseDesde: new Date() });
});

describe("baseLista con una base por cliente", () => {
  it("con la base lista, sí", async () => {
    expect(await baseLista("u-1")).toBe(true);
  });

  it.each(["creando", "fallida", "borrada", null, undefined])("con la base en %j, no", async (base) => {
    h.fila.mockResolvedValue({ id: "u-1", tenant_id: "t-1", role: "owner", base, baseDesde: new Date() });

    expect(await baseLista("u-1")).toBe(false);
  });

  it("sin fila de usuario, no", async () => {
    h.fila.mockResolvedValue(null);

    expect(await baseLista("u-1")).toBe(false);
  });

  it("lee la fila sin la copia en memoria: primero la olvida, después la pide", async () => {
    await baseLista("u-1");

    expect(h.olvidar).toHaveBeenCalledWith("u-1");
    expect(h.fila).toHaveBeenCalledWith("u-1");
    expect(h.olvidar.mock.invocationCallOrder[0]).toBeLessThan(h.fila.mock.invocationCallOrder[0]);
  });

  it("si la base no contesta, tira: decide quien llama", async () => {
    h.fila.mockRejectedValue(new Error("timeout"));

    await expect(baseLista("u-1")).rejects.toThrow("timeout");
  });
});

describe("baseLista con una sola base", () => {
  beforeEach(() => {
    delete process.env.BASE_POR_CLIENTE;
  });

  it("siempre sí, sin consultar nada", async () => {
    expect(await baseLista("u-1")).toBe(true);
    expect(h.olvidar).not.toHaveBeenCalled();
    expect(h.fila).not.toHaveBeenCalled();
  });

  it.each(["0", "", "true", "si"])("BASE_POR_CLIENTE=%j tampoco la prende", async (valor) => {
    process.env.BASE_POR_CLIENTE = valor;

    expect(await baseLista("u-1")).toBe(true);
    expect(h.fila).not.toHaveBeenCalled();
  });
});
