/**
 * Las acciones del panel del número de /configuracion: `pedirCodigoDelNumero` y
 * `verificarCodigoDelNumero`.
 *
 * Lo que se prueba es la puerta, no el flujo (de eso se ocupa `numero-automatico.test.ts`):
 *   - sin sesión va a /login; sin rol de owner o admin, o con un espacio que no
 *     es del alta automática, a /bandeja, sin llegar al número automático;
 *   - quién pide sale de la sesión y de los headers, nunca del cuerpo;
 *   - el método y el código se limpian antes de pasar;
 *   - el resultado vuelve en `?wa=` y un fallo inesperado es `meta`, sin que el
 *     mensaje del error llegue al registro;
 *   - el `redirect` va afuera de todo try/catch.
 */

import { isIP } from "node:net";

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  pedirCodigo: vi.fn(),
  verificarCodigo: vi.fn(),
  cabeceras: vi.fn(),
  error: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => h.cabeceras() }));

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
vi.mock("@/lib/audit/log", () => ({ ipValida: (ip?: string | null) => (ip && isIP(ip) !== 0 ? ip : null) }));
vi.mock("@/lib/auth/require-role", () => ({ ADMIN_ROLES: ["owner", "admin"], requireRole: h.requireRole }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: h.error },
}));
vi.mock("@/server/alta/numero-automatico", () => ({
  pedirCodigo: h.pedirCodigo,
  verificarCodigo: h.verificarCodigo,
}));

import { AppError } from "@/lib/errors";
import { pedirCodigoDelNumero, verificarCodigoDelNumero } from "@/app/(app)/configuracion/numero-actions";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USUARIO = "22222222-2222-4222-8222-222222222222";

function fila(cambios: Record<string, unknown> = {}) {
  return { userRow: { id: USUARIO, tenant_id: TENANT, role: "owner", autoalta: true, locale: "es-AR", ...cambios } };
}

function formulario(campos: Record<string, string> = {}): FormData {
  const form = new FormData();
  for (const [campo, valor] of Object.entries(campos)) form.set(campo, valor);
  return form;
}

type Accion = (form: FormData) => Promise<void>;

/** A dónde mandó la acción: las dos terminan siempre en un `redirect`. */
async function destinoDe(accion: Accion, form = formulario()): Promise<string> {
  try {
    await accion(form);
  } catch (e) {
    if (e instanceof RedirigioA) return e.destino;
    throw e;
  }
  throw new Error("la acción no redirigió");
}

const ACCIONES: Array<[string, Accion]> = [
  ["pedirCodigoDelNumero", pedirCodigoDelNumero],
  ["verificarCodigoDelNumero", verificarCodigoDelNumero],
];

beforeEach(() => {
  vi.clearAllMocks();
  h.requireRole.mockResolvedValue(fila());
  h.cabeceras.mockReturnValue(new Headers({ "x-forwarded-for": "203.0.113.7" }));
  h.pedirCodigo.mockResolvedValue("codigo_enviado");
  h.verificarCodigo.mockResolvedValue("conectado");
});

describe.each(ACCIONES)("%s: la puerta", (_nombre, accion) => {
  it("pide owner o admin", async () => {
    await destinoDe(accion);

    expect(h.requireRole).toHaveBeenCalledWith("owner", "admin");
  });

  it("sin sesión va a /login y no llega al número automático", async () => {
    h.requireRole.mockRejectedValue(new AppError("MISSING_SESSION"));

    expect(await destinoDe(accion)).toBe("/login");
    expect(h.pedirCodigo).not.toHaveBeenCalled();
    expect(h.verificarCodigo).not.toHaveBeenCalled();
  });

  it("sin el rol va a /bandeja y no llega al número automático", async () => {
    h.requireRole.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    expect(await destinoDe(accion)).toBe("/bandeja");
    expect(h.pedirCodigo).not.toHaveBeenCalled();
    expect(h.verificarCodigo).not.toHaveBeenCalled();
  });

  it("un fallo cualquiera al pedir la sesión va a /bandeja", async () => {
    h.requireRole.mockRejectedValue(new Error("la base no contesta"));

    expect(await destinoDe(accion)).toBe("/bandeja");
    expect(h.pedirCodigo).not.toHaveBeenCalled();
    expect(h.verificarCodigo).not.toHaveBeenCalled();
  });

  it.each([false, null, undefined])("con autoalta %s va a /bandeja y no llega al número automático", async (autoalta) => {
    h.requireRole.mockResolvedValue(fila({ autoalta }));

    expect(await destinoDe(accion)).toBe("/bandeja");
    expect(h.pedirCodigo).not.toHaveBeenCalled();
    expect(h.verificarCodigo).not.toHaveBeenCalled();
  });

  it("si el número automático tira, va a ?wa=meta y anota sólo el nombre del error", async () => {
    h.pedirCodigo.mockRejectedValue(new TypeError("el token fake-meta-token no sirve"));
    h.verificarCodigo.mockRejectedValue(new TypeError("el token fake-meta-token no sirve"));

    expect(await destinoDe(accion, formulario({ codigo: "123456" }))).toBe("/configuracion?wa=meta");
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.error).toHaveBeenCalledWith({ error: "TypeError" }, "configuracion.numero_accion_fallo");
  });

  it("un valor que no es un Error se anota como UnknownError", async () => {
    h.pedirCodigo.mockRejectedValue("fake-texto-suelto");
    h.verificarCodigo.mockRejectedValue("fake-texto-suelto");

    expect(await destinoDe(accion, formulario({ codigo: "123456" }))).toBe("/configuracion?wa=meta");
    expect(h.error).toHaveBeenCalledWith({ error: "UnknownError" }, "configuracion.numero_accion_fallo");
  });

  it("el redirect va afuera del try: un resultado normal no se anota como fallo", async () => {
    await expect(accion(formulario({ codigo: "123456" }))).rejects.toBeInstanceOf(RedirigioA);

    expect(h.error).not.toHaveBeenCalled();
  });
});

describe("pedirCodigoDelNumero", () => {
  it("el resultado va a /configuracion?wa=", async () => {
    expect(await destinoDe(pedirCodigoDelNumero, formulario({ metodo: "SMS" }))).toBe("/configuracion?wa=codigo_enviado");

    h.pedirCodigo.mockResolvedValue("esperar");
    expect(await destinoDe(pedirCodigoDelNumero)).toBe("/configuracion?wa=esperar");

    h.pedirCodigo.mockResolvedValue("revision");
    expect(await destinoDe(pedirCodigoDelNumero)).toBe("/configuracion?wa=revision");
  });

  it("'VOICE' pasa VOICE", async () => {
    await destinoDe(pedirCodigoDelNumero, formulario({ metodo: "VOICE" }));

    expect(h.pedirCodigo).toHaveBeenCalledTimes(1);
    expect(h.pedirCodigo.mock.calls[0]?.[1]).toBe("VOICE");
  });

  it.each([["SMS"], ["x"], ["voice"], [""]])("%j pasa SMS", async (metodo) => {
    await destinoDe(pedirCodigoDelNumero, formulario({ metodo }));

    expect(h.pedirCodigo.mock.calls[0]?.[1]).toBe("SMS");
  });

  it("sin el campo pasa SMS", async () => {
    await destinoDe(pedirCodigoDelNumero);

    expect(h.pedirCodigo.mock.calls[0]?.[1]).toBe("SMS");
  });

  it("no llama a verificarCodigo", async () => {
    await destinoDe(pedirCodigoDelNumero);

    expect(h.verificarCodigo).not.toHaveBeenCalled();
  });
});

describe("verificarCodigoDelNumero", () => {
  it("el resultado va a /configuracion?wa=", async () => {
    expect(await destinoDe(verificarCodigoDelNumero, formulario({ codigo: "123456" }))).toBe("/configuracion?wa=conectado");

    h.verificarCodigo.mockResolvedValue("codigo_incorrecto");
    expect(await destinoDe(verificarCodigoDelNumero, formulario({ codigo: "123456" }))).toBe(
      "/configuracion?wa=codigo_incorrecto"
    );
  });

  it.each([
    [" 123 456 ", "123456"],
    ["123456", "123456"],
    ["123\t456\n", "123456"],
    ["12 34 56", "123456"],
  ])("%j llega como %j", async (tipeado, esperado) => {
    await destinoDe(verificarCodigoDelNumero, formulario({ codigo: tipeado }));

    expect(h.verificarCodigo).toHaveBeenCalledTimes(1);
    expect(h.verificarCodigo.mock.calls[0]?.[1]).toBe(esperado);
  });

  it("sin el campo llega vacío y es la regla del número automático la que lo rechaza", async () => {
    h.verificarCodigo.mockResolvedValue("codigo_invalido");

    expect(await destinoDe(verificarCodigoDelNumero)).toBe("/configuracion?wa=codigo_invalido");
    expect(h.verificarCodigo.mock.calls[0]?.[1]).toBe("");
  });

  it("no llama a pedirCodigo", async () => {
    await destinoDe(verificarCodigoDelNumero, formulario({ codigo: "123456" }));

    expect(h.pedirCodigo).not.toHaveBeenCalled();
  });

  it("el código no va a la URL ni al registro", async () => {
    h.verificarCodigo.mockRejectedValue(new Error("falló con 654321"));

    const destino = await destinoDe(verificarCodigoDelNumero, formulario({ codigo: "654321" }));

    expect(destino).not.toContain("654321");
    expect(JSON.stringify(h.error.mock.calls)).not.toContain("654321");
  });
});

describe.each(ACCIONES)("%s: quién pide", (_nombre, accion) => {
  it("sale de la sesión y de los headers, no del cuerpo", async () => {
    await destinoDe(accion, formulario({ tenant_id: "otro", user_id: "otro", ip: "198.51.100.9", locale: "en-US", codigo: "123456" }));

    const quien = (h.pedirCodigo.mock.calls[0] ?? h.verificarCodigo.mock.calls[0])?.[0];
    expect(quien).toEqual({ tenantId: TENANT, userId: USUARIO, ip: "203.0.113.7", idioma: "es-AR" });
  });

  it("el locale en-US de la cuenta llega como idioma", async () => {
    h.requireRole.mockResolvedValue(fila({ locale: "en-US" }));

    await destinoDe(accion, formulario({ codigo: "123456" }));

    const quien = (h.pedirCodigo.mock.calls[0] ?? h.verificarCodigo.mock.calls[0])?.[0];
    expect(quien.idioma).toBe("en-US");
  });

  it.each([["es-AR"], ["fr-FR"], [null], [undefined]])("el locale %s llega como es-AR", async (locale) => {
    h.requireRole.mockResolvedValue(fila({ locale }));

    await destinoDe(accion, formulario({ codigo: "123456" }));

    const quien = (h.pedirCodigo.mock.calls[0] ?? h.verificarCodigo.mock.calls[0])?.[0];
    expect(quien.idioma).toBe("es-AR");
  });

  it("la IP sale de x-forwarded-for", async () => {
    h.cabeceras.mockReturnValue(new Headers({ "x-forwarded-for": "198.51.100.23, 10.0.0.1" }));

    await destinoDe(accion, formulario({ codigo: "123456" }));

    const quien = (h.pedirCodigo.mock.calls[0] ?? h.verificarCodigo.mock.calls[0])?.[0];
    expect(quien.ip).toBe("198.51.100.23");
  });

  it("sin IP válida pasa null", async () => {
    h.cabeceras.mockReturnValue(new Headers());

    await destinoDe(accion, formulario({ codigo: "123456" }));

    const quien = (h.pedirCodigo.mock.calls[0] ?? h.verificarCodigo.mock.calls[0])?.[0];
    expect(quien.ip).toBeNull();
  });
});
