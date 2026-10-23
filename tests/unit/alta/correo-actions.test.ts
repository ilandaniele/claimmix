/**
 * `crearCuentaDesdeCorreo`: la acción de /alta/correo. Lee los campos del
 * formulario, se los pasa a `crearCuentaDelEnlace` (que tiene sus propias
 * pruebas) y redirige adonde ése diga. Lo que se prueba acá es sólo eso, y que el
 * `redirect` va afuera de todo try/catch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  crearCuentaDelEnlace: vi.fn(),
  error: vi.fn(),
}));

vi.mock("server-only", () => ({}));

const ENCABEZADOS = new Headers({ "x-forwarded-for": "203.0.113.7" });
vi.mock("next/headers", () => ({ headers: async () => ENCABEZADOS }));

/** `redirect` tira, igual que en Next: se atrapa el destino. */
class RedirigioA extends Error {
  constructor(public readonly destino: string) {
    super(`NEXT_REDIRECT:${destino}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new RedirigioA(destino);
  },
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: h.error },
}));
vi.mock("@/server/alta/cuenta-del-enlace", () => ({ crearCuentaDelEnlace: h.crearCuentaDelEnlace }));

function formulario(campos: Record<string, string | undefined>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) if (v !== undefined) fd.set(k, v);
  return fd;
}

/** Corre la acción y devuelve adónde redirigió. */
async function enviar(campos: Record<string, string | undefined>): Promise<string> {
  const { crearCuentaDesdeCorreo } = await import("@/app/alta/correo/actions");
  try {
    await crearCuentaDesdeCorreo(formulario(campos));
  } catch (e) {
    if (e instanceof RedirigioA) return e.destino;
    throw e;
  }
  throw new Error("crearCuentaDesdeCorreo no redirigió");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.crearCuentaDelEnlace.mockResolvedValue("/alta");
});

describe("crearCuentaDesdeCorreo", () => {
  it("pasa el enlace, la contraseña, la repetida y los encabezados, y redirige a /alta", async () => {
    expect(await enviar({ t: "fake-token", password: "fake-clave-1234", repetir: "fake-clave-1234" })).toBe("/alta");

    expect(h.crearCuentaDelEnlace).toHaveBeenCalledTimes(1);
    expect(h.crearCuentaDelEnlace).toHaveBeenCalledWith({
      token: "fake-token",
      clave: "fake-clave-1234",
      repetida: "fake-clave-1234",
      headerStore: ENCABEZADOS,
    });
  });

  it("un campo que falta llega como null, sin inventar nada", async () => {
    await enviar({});

    expect(h.crearCuentaDelEnlace).toHaveBeenCalledWith({
      token: null,
      clave: null,
      repetida: null,
      headerStore: ENCABEZADOS,
    });
  });

  it.each([
    "/alta/correo",
    "/alta/correo?t=fake-token&e=clave",
    "/login?aviso=ya_tenes_cuenta",
    "/login?error=registro_cerrado",
    "/login",
  ])("redirige adonde dice el módulo: %s", async (destino) => {
    h.crearCuentaDelEnlace.mockResolvedValue(destino);

    expect(await enviar({ t: "fake-token" })).toBe(destino);
  });

  it("el redirect está afuera del try: no queda anotado como falla", async () => {
    await enviar({ t: "fake-token" });

    expect(h.error).not.toHaveBeenCalled();
  });
});
