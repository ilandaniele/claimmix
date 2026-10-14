/**
 * POST /api/auth/salir: cierra la sesión y contesta 303 a /login. Tiene que ser una
 * respuesta HTTP y no un `redirect()` de Server Action: ése es un salto del cliente y
 * /login heredaba el CSP y el SDK de Meta de /conectar-whatsapp.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ cerrarSesion: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/cerrar-sesion", () => ({ cerrarSesion: h.cerrarSesion }));

import { POST } from "@/app/api/auth/salir/route";

beforeEach(() => {
  vi.clearAllMocks();
  h.cerrarSesion.mockResolvedValue(undefined);
});

describe("POST /api/auth/salir", () => {
  it("cierra la sesión y manda a /login con un 303 para que el navegador pida con GET", async () => {
    const res = await POST();

    expect(h.cerrarSesion).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("si la base falla no contesta la redirección: la sesión no quedó cerrada", async () => {
    h.cerrarSesion.mockRejectedValue(new Error("db"));

    await expect(POST()).rejects.toThrow("db");
  });
});
