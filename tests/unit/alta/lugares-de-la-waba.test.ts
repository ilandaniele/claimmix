/**
 * Los lugares libres de la WABA de la plataforma: una recorrida de Graph, sin base,
 * y sin dato cuando Graph no contestó o la lista quedó a medias.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  credencial: vi.fn(),
  recorrer: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/whatsapp/numeros", () => ({ credencialDelEntorno: h.credencial }));
vi.mock("@/server/whatsapp/verificar-en-meta", () => ({ recorrerLaWaba: h.recorrer }));

import { lugaresDeLaWaba } from "@/server/alta/lugares-de-la-waba";

const CRED = { accessToken: "test-token", phoneNumberId: "111", wabaId: "222" };
const fila = (id: string) => ({ id, display: null, nombre: null });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ALTA_NUMEROS_MAXIMOS_WABA", "");
  h.credencial.mockReturnValue(CRED);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("lugaresDeLaWaba", () => {
  it("sin credencial da null y no recorre", async () => {
    h.credencial.mockReturnValue(null);
    expect(await lugaresDeLaWaba()).toBeNull();
    expect(h.recorrer).not.toHaveBeenCalled();
  });

  it("sin WABA en la credencial da null y no recorre", async () => {
    h.credencial.mockReturnValue({ ...CRED, wabaId: null });
    expect(await lugaresDeLaWaba()).toBeNull();
    expect(h.recorrer).not.toHaveBeenCalled();
  });

  it("recorre la WABA de la plataforma una sola vez, pidiendo sólo el id", async () => {
    h.recorrer.mockResolvedValue({ filas: [fila("1")], completa: true });
    await lugaresDeLaWaba();
    expect(h.recorrer).toHaveBeenCalledTimes(1);
    expect(h.recorrer).toHaveBeenCalledWith("222", "id", "test-token");
  });

  it("si Graph no contestó da null", async () => {
    h.recorrer.mockResolvedValue(null);
    expect(await lugaresDeLaWaba()).toBeNull();
  });

  it("una lista incompleta da null", async () => {
    h.recorrer.mockResolvedValue({ filas: [fila("1")], completa: false });
    expect(await lugaresDeLaWaba()).toBeNull();
  });

  it("con el tope por defecto, una fila deja un lugar", async () => {
    h.recorrer.mockResolvedValue({ filas: [fila("1")], completa: true });
    expect(await lugaresDeLaWaba()).toEqual({ usados: 1, tope: 2, libres: 1 });
  });

  it("pasado el tope los libres son cero, nunca negativos", async () => {
    h.recorrer.mockResolvedValue({ filas: [fila("1"), fila("2"), fila("3")], completa: true });
    expect(await lugaresDeLaWaba()).toEqual({ usados: 3, tope: 2, libres: 0 });
  });

  it("ALTA_NUMEROS_MAXIMOS_WABA cambia el tope", async () => {
    vi.stubEnv("ALTA_NUMEROS_MAXIMOS_WABA", "5");
    h.recorrer.mockResolvedValue({ filas: [fila("1"), fila("2")], completa: true });
    expect(await lugaresDeLaWaba()).toEqual({ usados: 2, tope: 5, libres: 3 });
  });

  it("si la recorrida tira da null", async () => {
    h.recorrer.mockRejectedValue(new Error("boom"));
    expect(await lugaresDeLaWaba()).toBeNull();
  });

  it("si la credencial tira da null", async () => {
    h.credencial.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(await lugaresDeLaWaba()).toBeNull();
  });
});
