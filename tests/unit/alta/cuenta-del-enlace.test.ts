/**
 * `crearCuentaDelEnlace`: donde nace la cuenta de quien volvió del mail.
 *
 * Hasta acá /registro no escribió nada, y desde acá no hay espacio: la cuenta
 * queda con el correo verificado y la sesión abierta, y la persona sigue a /alta.
 * Lo que se prueba:
 *   - el orden: cuenta, correo verificado, sesión;
 *   - que no se crea espacio, ni perfil, ni se toma ni se libera el cupo del alta;
 *   - que un usuario de mentira de Better Auth (la cuenta ya existía) o un
 *     enlace usado dos veces caen en «ya tenés cuenta» sin tocar nada;
 *   - que un enlace malo, o una contraseña que no vale, no gastan cupo ni crean nada;
 *   - que un enlace emitido antes de separar los pasos (lleva empresa y número)
 *     abre sólo la cuenta.
 */

import { APIError } from "better-auth/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  signUpEmail: vi.fn(),
  signInEmail: vi.fn(),
  findUserById: vi.fn(),
  marcarVerificado: vi.fn(),
  crearInquilino: vi.fn(),
  iniciarBase: vi.fn(),
  topePorIp: vi.fn(),
  rateLimit: vi.fn(),
  liberarCupo: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  /** El camino de alta en curso (`enAlta`) en el momento de llamar a `signUpEmail`. */
  caminoAlCrear: [] as Array<string | undefined>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: { signUpEmail: h.signUpEmail, signInEmail: h.signInEmail },
    $context: Promise.resolve({ internalAdapter: { findUserById: h.findUserById } }),
  },
}));
vi.mock("@/lib/auth/on-password-reset", () => ({ marcarCorreoVerificado: h.marcarVerificado }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: h.error },
}));
vi.mock("@/lib/rate-limit/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/index")>()),
  topePorIp: h.topePorIp,
  rateLimit: h.rateLimit,
  liberarCupo: h.liberarCupo,
}));
vi.mock("@/server/alta/crear-inquilino", () => ({ crearInquilino: h.crearInquilino }));
vi.mock("@/server/bases/iniciar", () => ({ iniciarBase: h.iniciarBase }));

import { altaEnCursoPorServidor } from "@/lib/auth/registro-permitido";
import { crearCuentaDelEnlace, YA_TENES_CUENTA } from "@/server/alta/cuenta-del-enlace";
import { DURACION_DEL_TOKEN_MS, sellarToken } from "@/server/alta/token-de-registro";

const SECRETO = "fake-secreto-del-enlace-de-alta-0123456789";
const IP = "203.0.113.7";
const CLAVE = "fake-clave-de-prueba-1234";
const USUARIO = "11111111-1111-4111-8111-111111111111";
const LIBRE = { allowed: true, remaining: 2, resetAt: 0, retryAfterSeconds: 0 };
const AGOTADO = { allowed: false, remaining: 0, resetAt: 0, retryAfterSeconds: 3600 };

const DATOS = { e: "ana@example.com", nombre: "Ana Pérez", locale: "es-AR" as const };

let token: string;

/** Corre el módulo con un pedido de verdad y devuelve adónde sigue. */
function enlace(campos: { t?: unknown; password?: unknown; repetir?: unknown } = {}): Promise<string> {
  const c = { t: token, password: CLAVE, repetir: CLAVE, ...campos };
  return crearCuentaDelEnlace({
    token: c.t,
    clave: c.password,
    repetida: c.repetir,
    headerStore: new Headers({ "x-forwarded-for": IP }),
  });
}

const orden = (f: ReturnType<typeof vi.fn>) => f.mock.invocationCallOrder[0];

/** No se creó ni se tocó nada. */
function nadaTocado() {
  expect(h.signUpEmail).not.toHaveBeenCalled();
  expect(h.marcarVerificado).not.toHaveBeenCalled();
  expect(h.signInEmail).not.toHaveBeenCalled();
}

/** Ni espacio, ni cupo del alta, ni base por cliente: eso es del segundo paso. */
function sinEspacio() {
  expect(h.crearInquilino).not.toHaveBeenCalled();
  expect(h.rateLimit).not.toHaveBeenCalled();
  expect(h.liberarCupo).not.toHaveBeenCalled();
  expect(h.iniciarBase).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.caminoAlCrear.length = 0;
  process.env.BETTER_AUTH_SECRET = SECRETO;
  process.env.ALTA_AUTOMATICA = "1";
  delete process.env.BASE_POR_CLIENTE;
  delete process.env.SIGNUP_ALLOWED_EMAILS;
  delete process.env.ADMIN_EMAILS;
  token = sellarToken(DATOS);
  h.topePorIp.mockResolvedValue(LIBRE);
  h.signUpEmail.mockImplementation(async () => {
    h.caminoAlCrear.push(altaEnCursoPorServidor());
    return { user: { id: USUARIO }, token: null };
  });
  h.findUserById.mockResolvedValue({ id: USUARIO });
  h.marcarVerificado.mockResolvedValue(undefined);
  h.signInEmail.mockResolvedValue({ token: "fake-sesion" });
});

afterEach(() => {
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.ALTA_AUTOMATICA;
});

describe("el camino feliz", () => {
  it("crea la cuenta, la verifica, abre la sesión y sigue a /alta", async () => {
    expect(await enlace()).toBe("/alta");

    expect(h.signUpEmail).toHaveBeenCalledWith({
      body: { name: "Ana Pérez", email: "ana@example.com", password: CLAVE },
      headers: expect.any(Headers),
    });
    expect(h.findUserById).toHaveBeenCalledWith(USUARIO);
    expect(h.marcarVerificado).toHaveBeenCalledWith(USUARIO);
    expect(h.signInEmail).toHaveBeenCalledWith({
      body: { email: "ana@example.com", password: CLAVE },
      headers: expect.any(Headers),
    });
  });

  it("en ese orden: cuenta, correo verificado, sesión", async () => {
    await enlace();

    expect(orden(h.signUpEmail)).toBeLessThan(orden(h.marcarVerificado));
    expect(orden(h.marcarVerificado)).toBeLessThan(orden(h.signInEmail));
  });

  it("no crea espacio, ni toma el cupo del alta, ni lanza una base por cliente", async () => {
    process.env.BASE_POR_CLIENTE = "1";

    await enlace();

    sinEspacio();
  });

  it("la cuenta se crea adentro de `enAlta('correo')`", async () => {
    await enlace();

    expect(h.caminoAlCrear).toEqual(["correo"]);
  });

  it("la cuenta se crea sin cookies: la sesión se abre recién con el correo verificado", async () => {
    await enlace();

    const { headers } = h.signUpEmail.mock.calls[0][0] as { headers: Headers };
    expect([...headers.keys()]).toEqual([]);
  });

  it("la sesión se abre con los encabezados del pedido: ahí viaja la cookie que se devuelve", async () => {
    const headerStore = new Headers({ "x-forwarded-for": IP });
    await crearCuentaDelEnlace({ token, clave: CLAVE, repetida: CLAVE, headerStore });

    expect(h.signInEmail.mock.calls[0][0].headers).toBe(headerStore);
  });

  it("cuenta el tope por IP con la IP de la red", async () => {
    await enlace();

    expect(h.topePorIp).toHaveBeenCalledWith(IP);
  });

  it("no deja la contraseña en ningún registro", async () => {
    h.signUpEmail.mockRejectedValue(new Error("la base se cayó"));
    await enlace();
    h.signUpEmail.mockResolvedValue({ user: { id: USUARIO }, token: null });
    h.signInEmail.mockRejectedValue(new Error("no entró"));
    await enlace();

    expect(JSON.stringify([h.error.mock.calls, h.warn.mock.calls])).not.toContain(CLAVE);
  });
});

describe("una cuenta que ya existía", () => {
  it("el usuario de mentira de Better Auth (no está en la base) va a «ya tenés cuenta» sin tocar nada", async () => {
    h.signUpEmail.mockResolvedValue({ user: { id: "usuario-de-mentira" }, token: null });
    h.findUserById.mockResolvedValue(null);

    expect(await enlace()).toBe(YA_TENES_CUENTA);

    expect(h.findUserById).toHaveBeenCalledWith("usuario-de-mentira");
    expect(h.marcarVerificado).not.toHaveBeenCalled();
    expect(h.signInEmail).not.toHaveBeenCalled();
    sinEspacio();
  });

  it("si Better Auth tira USER_ALREADY_EXISTS, lo mismo", async () => {
    h.signUpEmail.mockRejectedValue(
      new APIError("UNPROCESSABLE_ENTITY", { code: "USER_ALREADY_EXISTS", message: "User already exists" })
    );

    expect(await enlace()).toBe(YA_TENES_CUENTA);

    expect(h.marcarVerificado).not.toHaveBeenCalled();
    expect(h.signInEmail).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
    sinEspacio();
  });

  it("el enlace usado dos veces: la primera crea, la segunda cae en «ya tenés cuenta»", async () => {
    expect(await enlace()).toBe("/alta");

    // Better Auth contesta con un usuario que ya no es nuevo: no está en la base como creado ahora.
    h.signUpEmail.mockResolvedValue({ user: { id: "usuario-de-mentira" }, token: null });
    h.findUserById.mockResolvedValue(null);

    expect(await enlace()).toBe(YA_TENES_CUENTA);
    expect(h.marcarVerificado).toHaveBeenCalledTimes(1);
    expect(h.signInEmail).toHaveBeenCalledTimes(1);
  });

  it("«ya tenés cuenta» es el mismo destino para quien no estaba y para quien sí: no cuenta nada de la cuenta", () => {
    expect(YA_TENES_CUENTA).toBe("/login?aviso=ya_tenes_cuenta");
  });
});

describe("un enlace que no vale", () => {
  it.each([
    ["sin enlace", { t: undefined }],
    ["vacío", { t: "" }],
    ["con basura", { t: "basura" }],
    ["que no es un texto", { t: 42 }],
    ["adulterado", { t: "se arma abajo" }],
  ])("%s va a /alta/correo, que dice «enlace vencido», sin cupo ni cuenta", async (_caso, cambio) => {
    const t = cambio.t === "se arma abajo" ? `${token.slice(0, -2)}AA` : cambio.t;

    expect(await enlace({ t })).toBe("/alta/correo");

    expect(h.topePorIp).not.toHaveBeenCalled();
    nadaTocado();
  });

  it("vencido va a /alta/correo", async () => {
    token = sellarToken(DATOS, Date.now() - DURACION_DEL_TOKEN_MS - 1000);

    expect(await enlace()).toBe("/alta/correo");

    expect(h.topePorIp).not.toHaveBeenCalled();
    nadaTocado();
  });

  it("sellado con otra clave va a /alta/correo", async () => {
    process.env.BETTER_AUTH_SECRET = "fake-otro-secreto-que-no-es-el-de-antes-9876543210";

    expect(await enlace()).toBe("/alta/correo");

    nadaTocado();
  });
});

describe("un enlace emitido antes de separar los dos pasos", () => {
  it("lleva empresa y número, y abre sólo la cuenta: esas claves se descartan", async () => {
    // Por una variable: el tipo ya no los acepta, pero un enlace viejo todavía los trae.
    const viejo = { ...DATOS, empresa: "Seguros del Sur", numero: "+5492916426930" };
    token = sellarToken(viejo);

    expect(await enlace()).toBe("/alta");

    expect(h.signUpEmail).toHaveBeenCalledWith({
      body: { name: "Ana Pérez", email: "ana@example.com", password: CLAVE },
      headers: expect.any(Headers),
    });
    sinEspacio();
  });
});

describe("una contraseña que no vale", () => {
  it.each([
    ["corta", { password: "1234567", repetir: "1234567" }, "clave"],
    ["larga", { password: "a".repeat(129), repetir: "a".repeat(129) }, "clave"],
    ["ausente", { password: undefined, repetir: undefined }, "clave"],
    ["que no es un texto", { password: 12345678, repetir: 12345678 }, "clave"],
    ["distinta de la repetida", { repetir: "fake-otra-clave-1234" }, "distintas"],
    ["sin repetir", { repetir: undefined }, "distintas"],
  ])("%s vuelve al formulario con el motivo, sin cupo ni cuenta", async (_caso, campos, motivo) => {
    expect(await enlace(campos)).toBe(`/alta/correo?t=${token}&e=${motivo}`);

    expect(h.topePorIp).not.toHaveBeenCalled();
    nadaTocado();
  });

  it("de 8 y de 128 caracteres valen", async () => {
    expect(await enlace({ password: "12345678", repetir: "12345678" })).toBe("/alta");
    expect(await enlace({ password: "a".repeat(128), repetir: "a".repeat(128) })).toBe("/alta");
  });
});

describe("el alta cerrada y el cupo por red", () => {
  it("con el alta cerrada para la dirección va al login, sin cupo ni cuenta", async () => {
    delete process.env.ALTA_AUTOMATICA;
    process.env.SIGNUP_ALLOWED_EMAILS = "@otra-empresa.example.com";

    expect(await enlace()).toBe("/login?error=registro_cerrado");

    expect(h.topePorIp).not.toHaveBeenCalled();
    nadaTocado();
  });

  it("con la dirección en la lista, sin ALTA_AUTOMATICA, sí crea", async () => {
    delete process.env.ALTA_AUTOMATICA;
    process.env.SIGNUP_ALLOWED_EMAILS = "@example.com";

    expect(await enlace()).toBe("/alta");
  });

  it("sin cupo por IP vuelve al formulario con «intentos» y no crea nada", async () => {
    h.topePorIp.mockResolvedValue(AGOTADO);

    expect(await enlace()).toBe(`/alta/correo?t=${token}&e=intentos`);

    nadaTocado();
  });
});

describe("cuando algo falla", () => {
  it("si Better Auth no puede crear la cuenta vuelve al formulario con «falla» y lo anota", async () => {
    h.signUpEmail.mockRejectedValue(new Error("la base se cayó"));

    expect(await enlace()).toBe(`/alta/correo?t=${token}&e=falla`);

    expect(h.error).toHaveBeenCalledWith({ detalle: "Error" }, "alta.correo_cuenta_no_creada");
    expect(h.marcarVerificado).not.toHaveBeenCalled();
    expect(h.signInEmail).not.toHaveBeenCalled();
    sinEspacio();
  });

  it("un dominio con SSO exigido (el gancho de Better Auth rechaza) vuelve con «falla», sin cuenta a medias", async () => {
    h.signUpEmail.mockRejectedValue(
      new APIError("UNPROCESSABLE_ENTITY", { code: "sso_requerido", message: "sso_requerido" })
    );

    expect(await enlace()).toBe(`/alta/correo?t=${token}&e=falla`);

    expect(h.error).toHaveBeenCalledWith({ detalle: "sso_requerido" }, "alta.correo_cuenta_no_creada");
    expect(h.marcarVerificado).not.toHaveBeenCalled();
    sinEspacio();
  });

  it("si no se puede abrir la sesión va al login: la cuenta existe y entra con su contraseña", async () => {
    h.signInEmail.mockRejectedValue(new Error("no entró"));

    expect(await enlace()).toBe("/login");

    expect(h.marcarVerificado).toHaveBeenCalledWith(USUARIO);
    expect(h.error).toHaveBeenCalledWith({ detalle: "Error" }, "alta.correo_sin_sesion");
    sinEspacio();
  });
});
