/**
 * Tres viajes a Neon antes del primer byte útil.
 *
 * Toda ruta de la API hacía lo mismo y en fila: la sesión, la fila de `users`,
 * el cupo. Las tres consultas se ejecutan en milisegundos; lo que se paga es el
 * viaje, ~65 ms cada uno.
 *
 * Las dos últimas no dependen una de otra: las dos necesitan el id del usuario
 * y nada más.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSesion, mockRequireRole, mockRateLimit, mockBuildUserKey } = vi.hoisted(() => ({
  mockSesion: vi.fn(),
  mockRequireRole: vi.fn(),
  mockRateLimit: vi.fn(),
  mockBuildUserKey: vi.fn((id: string, etiqueta: string) => `user:${id}:${etiqueta}`),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: mockSesion }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mockRequireRole }));
vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: mockRateLimit,
  buildUserKey: mockBuildUserKey,
}));

import { entrar } from "@/lib/api/entrada";
import { AppError } from "@/lib/errors";

const CUPO = { limit: 100, windowMs: 60_000 };
const RL = { allowed: true, remaining: 99, resetAt: 0, retryAfterSeconds: 0 };

/** Resuelve cuando alguien la suelta: sirve para ver si dos cosas se solaparon. */
function pendiente<T>(valor: T) {
  let soltar!: () => void;
  const p = new Promise<T>((r) => { soltar = () => r(valor); });
  return { p, soltar };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSesion.mockResolvedValue({ user: { id: "u-1" } });
  mockRequireRole.mockResolvedValue({
    user: { id: "u-1" },
    userRow: { id: "u-1", tenant_id: "t-1", role: "analyst" },
  });
  mockRateLimit.mockResolvedValue(RL);
});

afterEach(() => vi.restoreAllMocks());

describe("entrar", () => {
  it("el rol y el cupo salen juntos, no uno después del otro", async () => {
    // Lo que se prueba es el solapamiento: con el rol trabado, el cupo tiene
    // que haber arrancado igual. En serie, ni se habría llamado.
    const rol = pendiente({
      user: { id: "u-1" },
      userRow: { id: "u-1", tenant_id: "t-1", role: "analyst" },
    });
    mockRequireRole.mockReturnValue(rol.p);

    const enCurso = entrar("cases-list", CUPO, "analyst");
    await Promise.resolve();

    expect(mockRateLimit).toHaveBeenCalledTimes(1);

    rol.soltar();
    await enCurso;
  });

  it("la clave del cupo lleva el usuario y la etiqueta de la ruta", async () => {
    // Una etiqueta por ruta: dos pantallas distintas no comparten tope.
    await entrar("cases-list", CUPO, "analyst");
    expect(mockRateLimit).toHaveBeenCalledWith("user:u-1:cases-list", CUPO);
  });

  it("y cuando el cupo no es por usuario, la arma quien llama", async () => {
    // El re-análisis cuenta por CASO: cinco por hora sobre el mismo siniestro.
    await entrar((id) => `re-analyze:caso-9:${id}`, CUPO, "analyst");
    expect(mockRateLimit).toHaveBeenCalledWith("re-analyze:caso-9:u-1", CUPO);
    expect(mockBuildUserKey).not.toHaveBeenCalled();
  });

  it("sin sesión no consulta nada", async () => {
    // No hay a quién contarle el cupo, y no hay fila de users que buscar.
    mockSesion.mockResolvedValue(null);

    await expect(entrar("cases-list", CUPO, "analyst")).rejects.toBeInstanceOf(AppError);
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockRateLimit).not.toHaveBeenCalled();
  });

  it("el rol equivocado ya cuenta contra el cupo", async () => {
    /*
     * Cambia de comportamiento y es a propósito. Antes `requireRole` tiraba
     * primero y el limitador no se enteraba: alguien con sesión válida y rol
     * equivocado podía golpear una ruta prohibida sin tope ninguno.
     */
    mockRequireRole.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    await expect(entrar("cases-list", CUPO, "admin")).rejects.toBeInstanceOf(AppError);
    expect(mockRateLimit).toHaveBeenCalledTimes(1);
  });
});
