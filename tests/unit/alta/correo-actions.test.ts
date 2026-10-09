/**
 * `crearCuentaDesdeCorreo`: la acción de /alta/correo, donde nace la cuenta.
 *
 * Hasta acá /registro no escribió nada. Lo que se prueba:
 *   - el orden: cuenta, correo verificado, espacio, sesión;
 *   - que un usuario de mentira de Better Auth (la cuenta ya existía) o un
 *     enlace usado dos veces caen en «ya tenés cuenta» sin tocar nada;
 *   - que con el alta cerrada, o si la base no pudo crear el espacio, la cuenta
 *     queda verificada y con sesión pero sin espacio, y /alta deja reintentar;
 *   - que un enlace malo, o una contraseña que no vale, no gastan cupo ni crean nada;
 *   - que el `redirect` va afuera de todo try/catch.
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
  llegoAlAviso: vi.fn(),
  avisarAlOperador: vi.fn(),
  topePorIp: vi.fn(),
  rateLimit: vi.fn(),
  liberarCupo: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  /** El camino de alta en curso (`enAlta`) en el momento de llamar a `signUpEmail`. */
  caminoAlCrear: [] as Array<string | undefined>,
  /** Lo que la acción dejó para después de responder (`after`). */
  pendientes: [] as Array<() => unknown>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));

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
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (tarea: () => unknown) => {
    h.pendientes.push(tarea);
  },
}));

vi.mock("@/lib/audit/log", () => ({ ipValida: (ip: string) => ip }));
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
vi.mock("@/server/alta/aviso-operador", () => ({
  llegoAlAviso: h.llegoAlAviso,
  avisarAlOperador: h.avisarAlOperador,
}));
vi.mock("@/server/alta/crear-inquilino", () => ({ crearInquilino: h.crearInquilino }));
vi.mock("@/server/bases/iniciar", () => ({ iniciarBase: h.iniciarBase }));

import { altaEnCursoPorServidor } from "@/lib/auth/registro-permitido";
import { DURACION_DEL_TOKEN_MS, sellarToken } from "@/server/alta/token-de-registro";

const SECRETO = "fake-secreto-del-enlace-de-alta-0123456789";
const IP = "203.0.113.7";
const CLAVE = "fake-clave-de-prueba-1234";
const USUARIO = "11111111-1111-4111-8111-111111111111";
const LIBRE = { allowed: true, remaining: 2, resetAt: 0, retryAfterSeconds: 0 };
const AGOTADO = { allowed: false, remaining: 0, resetAt: 0, retryAfterSeconds: 3600 };
/** El cupo de espacios por red (`alta:ip`): `ventana` es donde el limitador lo contó. */
const CUPO_LIBRE = { ...LIBRE, ventana: 7 };
const CLAVE_DEL_CUPO = "alta:ip:203.0.113.7";
const YA_TENES_CUENTA = "/login?aviso=ya_tenes_cuenta";

const DATOS = {
  e: "ana@example.com",
  empresa: "Seguros del Sur",
  numero: "+5492916426930",
  nombre: "Ana Pérez",
  locale: "es-AR" as const,
};

let token: string;

const alta = (resultado: string, extra: Record<string, unknown> = {}) => ({
  resultado,
  tenantId: "22222222-2222-4222-8222-222222222222",
  creadas24h: 1,
  tope: 20,
  ...extra,
});

function formulario(campos: Record<string, string | undefined>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) if (v !== undefined) fd.set(k, v);
  return fd;
}

/** Corre la acción y devuelve adónde redirigió. */
async function enviar(campos: Record<string, string | undefined> = {}): Promise<string> {
  const { crearCuentaDesdeCorreo } = await import("@/app/alta/correo/actions");
  try {
    await crearCuentaDesdeCorreo(formulario({ t: token, password: CLAVE, repetir: CLAVE, ...campos }));
  } catch (e) {
    if (e instanceof RedirigioA) return e.destino;
    throw e;
  }
  throw new Error("crearCuentaDesdeCorreo no redirigió");
}

const orden = (f: ReturnType<typeof vi.fn>) => f.mock.invocationCallOrder[0];

/** No se creó ni se tocó nada. */
function nadaTocado() {
  expect(h.signUpEmail).not.toHaveBeenCalled();
  expect(h.marcarVerificado).not.toHaveBeenCalled();
  expect(h.crearInquilino).not.toHaveBeenCalled();
  expect(h.signInEmail).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.pendientes.length = 0;
  h.caminoAlCrear.length = 0;
  process.env.BETTER_AUTH_SECRET = SECRETO;
  process.env.ALTA_AUTOMATICA = "1";
  delete process.env.BASE_POR_CLIENTE;
  delete process.env.SIGNUP_ALLOWED_EMAILS;
  delete process.env.ADMIN_EMAILS;
  token = sellarToken(DATOS);
  h.topePorIp.mockResolvedValue(LIBRE);
  h.rateLimit.mockResolvedValue(CUPO_LIBRE);
  h.liberarCupo.mockResolvedValue(undefined);
  h.signUpEmail.mockImplementation(async () => {
    h.caminoAlCrear.push(altaEnCursoPorServidor());
    return { user: { id: USUARIO }, token: null };
  });
  h.findUserById.mockResolvedValue({ id: USUARIO });
  h.marcarVerificado.mockResolvedValue(undefined);
  h.crearInquilino.mockResolvedValue(alta("ok"));
  h.signInEmail.mockResolvedValue({ token: "fake-sesion" });
  h.llegoAlAviso.mockReturnValue(false);
  h.iniciarBase.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.ALTA_AUTOMATICA;
});

describe("el camino feliz", () => {
  it("crea la cuenta, la verifica, crea el espacio, abre la sesión y va a la bienvenida", async () => {
    expect(await enviar()).toBe("/bandeja?bienvenida=1");

    expect(h.signUpEmail).toHaveBeenCalledWith({
      body: { name: "Ana Pérez", email: "ana@example.com", password: CLAVE },
      headers: expect.any(Headers),
    });
    expect(h.findUserById).toHaveBeenCalledWith(USUARIO);
    expect(h.marcarVerificado).toHaveBeenCalledWith(USUARIO);
    expect(h.crearInquilino).toHaveBeenCalledWith({
      userId: USUARIO,
      empresa: "Seguros del Sur",
      numero: "+5492916426930",
      ip: IP,
    });
    expect(h.signInEmail).toHaveBeenCalledWith({
      body: { email: "ana@example.com", password: CLAVE },
      headers: expect.any(Headers),
    });
  });

  it("en ese orden: cuenta, correo verificado, espacio, sesión", async () => {
    await enviar();

    expect(orden(h.signUpEmail)).toBeLessThan(orden(h.marcarVerificado));
    expect(orden(h.marcarVerificado)).toBeLessThan(orden(h.crearInquilino));
    expect(orden(h.crearInquilino)).toBeLessThan(orden(h.signInEmail));
  });

  it("la cuenta se crea adentro de `enAlta('correo')`", async () => {
    await enviar();

    expect(h.caminoAlCrear).toEqual(["correo"]);
  });

  it("la cuenta se crea sin cookies: la sesión se abre recién con el correo verificado", async () => {
    await enviar();

    const { headers } = h.signUpEmail.mock.calls[0][0] as { headers: Headers };
    expect([...headers.keys()]).toEqual([]);
  });

  it("el redirect está afuera del try: no queda anotado como falla", async () => {
    await enviar();

    expect(h.error).not.toHaveBeenCalled();
  });

  it("con el número en revisión también va a la bienvenida", async () => {
    h.crearInquilino.mockResolvedValue(alta("ok_numero_en_revision"));

    expect(await enviar()).toBe("/bandeja?bienvenida=1");
  });

  it("el aviso al operador sale DESPUÉS de responder, si el día llegó al aviso", async () => {
    h.llegoAlAviso.mockReturnValue(true);
    h.crearInquilino.mockResolvedValue(alta("ok", { creadas24h: 16, tope: 20 }));

    await enviar();
    expect(h.avisarAlOperador).not.toHaveBeenCalled();

    await Promise.all(h.pendientes.splice(0).map((tarea) => tarea()));
    expect(h.avisarAlOperador).toHaveBeenCalledWith(16, 20);
  });

  it("cuenta el tope por IP con la IP de la red", async () => {
    await enviar();

    expect(h.topePorIp).toHaveBeenCalledWith(IP);
  });

  it("toma el cupo de espacios por red (`alta:ip`) y, si el espacio nace, no lo devuelve", async () => {
    await enviar();

    expect(h.rateLimit).toHaveBeenCalledTimes(1);
    expect(h.rateLimit).toHaveBeenCalledWith(CLAVE_DEL_CUPO, {
      limit: 3,
      windowMs: 24 * 60 * 60_000,
      fallaCerrada: true,
    });
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("el cupo se toma después de verificar la cuenta y antes de crear el espacio", async () => {
    await enviar();

    expect(orden(h.marcarVerificado)).toBeLessThan(orden(h.rateLimit));
    expect(orden(h.rateLimit)).toBeLessThan(orden(h.crearInquilino));
  });

  it("con el número en revisión el espacio también nació: el cupo se queda gastado", async () => {
    h.crearInquilino.mockResolvedValue(alta("ok_numero_en_revision"));
    await enviar();

    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("no deja la contraseña en ningún registro", async () => {
    h.crearInquilino.mockRejectedValue(new Error("la base se cayó"));
    h.signInEmail.mockRejectedValue(new Error("no entró"));
    await enviar();

    expect(JSON.stringify([h.error.mock.calls, h.warn.mock.calls])).not.toContain(CLAVE);
  });
});

describe("con una base por cliente", () => {
  it("lanza la base del espacio nuevo y va a /preparando", async () => {
    process.env.BASE_POR_CLIENTE = "1";

    expect(await enviar()).toBe("/preparando");
    expect(h.iniciarBase).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
    expect(h.signInEmail).toHaveBeenCalledTimes(1);
  });

  it("sin espacio (alta cerrada) no lanza nada y la persona vuelve a /alta", async () => {
    process.env.BASE_POR_CLIENTE = "1";
    h.crearInquilino.mockResolvedValue(alta("alta_cerrada", { creadas24h: 20, tope: 20 }));

    expect(await enviar()).toBe("/alta?e=cerrada");
    expect(h.iniciarBase).not.toHaveBeenCalled();
  });

  it("apagada la bandera no lanza nada", async () => {
    expect(await enviar()).toBe("/bandeja?bienvenida=1");
    expect(h.iniciarBase).not.toHaveBeenCalled();
  });
});

describe("una cuenta que ya existía", () => {
  it("el usuario de mentira de Better Auth (no está en la base) va a «ya tenés cuenta» sin tocar nada", async () => {
    h.signUpEmail.mockResolvedValue({ user: { id: "usuario-de-mentira" }, token: null });
    h.findUserById.mockResolvedValue(null);

    expect(await enviar()).toBe(YA_TENES_CUENTA);

    expect(h.findUserById).toHaveBeenCalledWith("usuario-de-mentira");
    expect(h.marcarVerificado).not.toHaveBeenCalled();
    expect(h.crearInquilino).not.toHaveBeenCalled();
    expect(h.signInEmail).not.toHaveBeenCalled();
  });

  it("si Better Auth tira USER_ALREADY_EXISTS, lo mismo", async () => {
    h.signUpEmail.mockRejectedValue(
      new APIError("UNPROCESSABLE_ENTITY", { code: "USER_ALREADY_EXISTS", message: "User already exists" })
    );

    expect(await enviar()).toBe(YA_TENES_CUENTA);

    expect(h.marcarVerificado).not.toHaveBeenCalled();
    expect(h.crearInquilino).not.toHaveBeenCalled();
    expect(h.signInEmail).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
  });

  it("el enlace usado dos veces: la primera crea, la segunda cae en «ya tenés cuenta»", async () => {
    expect(await enviar()).toBe("/bandeja?bienvenida=1");
    expect(h.crearInquilino).toHaveBeenCalledTimes(1);

    // Better Auth contesta con un usuario que ya no es nuevo: no está en la base como creado ahora.
    h.signUpEmail.mockResolvedValue({ user: { id: "usuario-de-mentira" }, token: null });
    h.findUserById.mockResolvedValue(null);

    expect(await enviar()).toBe(YA_TENES_CUENTA);
    expect(h.marcarVerificado).toHaveBeenCalledTimes(1);
    expect(h.crearInquilino).toHaveBeenCalledTimes(1);
    expect(h.signInEmail).toHaveBeenCalledTimes(1);
  });
});

describe("un enlace que no vale", () => {
  it.each([
    ["sin enlace", { t: undefined }],
    ["vacío", { t: "" }],
    ["con basura", { t: "basura" }],
    ["adulterado", { t: "se arma abajo" }],
  ])("%s va a /alta/correo, que dice «enlace vencido», sin cupo ni cuenta", async (_caso, cambio) => {
    const t = "t" in cambio && cambio.t === "se arma abajo" ? `${token.slice(0, -2)}AA` : cambio.t;

    expect(await enviar({ t })).toBe("/alta/correo");

    expect(h.topePorIp).not.toHaveBeenCalled();
    nadaTocado();
  });

  it("vencido va a /alta/correo", async () => {
    token = sellarToken(DATOS, Date.now() - DURACION_DEL_TOKEN_MS - 1000);

    expect(await enviar()).toBe("/alta/correo");

    expect(h.topePorIp).not.toHaveBeenCalled();
    nadaTocado();
  });

  it("sellado con otra clave va a /alta/correo", async () => {
    process.env.BETTER_AUTH_SECRET = "fake-otro-secreto-que-no-es-el-de-antes-9876543210";

    expect(await enviar()).toBe("/alta/correo");

    nadaTocado();
  });
});

describe("una contraseña que no vale", () => {
  it.each([
    ["corta", { password: "1234567", repetir: "1234567" }, "clave"],
    ["larga", { password: "a".repeat(129), repetir: "a".repeat(129) }, "clave"],
    ["ausente", { password: undefined, repetir: undefined }, "clave"],
    ["distinta de la repetida", { repetir: "fake-otra-clave-1234" }, "distintas"],
    ["sin repetir", { repetir: undefined }, "distintas"],
  ])("%s vuelve al formulario con el motivo, sin cupo ni cuenta", async (_caso, campos, motivo) => {
    expect(await enviar(campos)).toBe(`/alta/correo?t=${token}&e=${motivo}`);

    expect(h.topePorIp).not.toHaveBeenCalled();
    nadaTocado();
  });

  it("de 8 y de 128 caracteres valen", async () => {
    expect(await enviar({ password: "12345678", repetir: "12345678" })).toBe("/bandeja?bienvenida=1");
    expect(await enviar({ password: "a".repeat(128), repetir: "a".repeat(128) })).toBe("/bandeja?bienvenida=1");
  });
});

describe("el alta cerrada y los cupos", () => {
  it("con el alta cerrada para la dirección va al login, sin cupo ni cuenta", async () => {
    delete process.env.ALTA_AUTOMATICA;
    process.env.SIGNUP_ALLOWED_EMAILS = "@otra-empresa.example.com";

    expect(await enviar()).toBe("/login?error=registro_cerrado");

    expect(h.topePorIp).not.toHaveBeenCalled();
    nadaTocado();
  });

  it("con la dirección en la lista, sin ALTA_AUTOMATICA, sí crea", async () => {
    delete process.env.ALTA_AUTOMATICA;
    process.env.SIGNUP_ALLOWED_EMAILS = "@example.com";

    expect(await enviar()).toBe("/bandeja?bienvenida=1");
  });

  it("sin cupo por IP vuelve al formulario con «intentos» y no crea nada", async () => {
    h.topePorIp.mockResolvedValue(AGOTADO);

    expect(await enviar()).toBe(`/alta/correo?t=${token}&e=intentos`);

    nadaTocado();
  });

  it("con el cupo de espacios por red agotado la cuenta queda con sesión, sin espacio, y /alta dice «intentos»", async () => {
    h.rateLimit.mockResolvedValue({ ...AGOTADO, ventana: 7 });

    expect(await enviar()).toBe("/alta?e=intentos");

    expect(h.crearInquilino).not.toHaveBeenCalled();
    expect(h.marcarVerificado).toHaveBeenCalledWith(USUARIO);
    expect(h.signInEmail).toHaveBeenCalledTimes(1);
  });

  it("si el contador no contesta (`ventana: 0`) no hay espacio y /alta dice «falla», no «intentos»", async () => {
    h.rateLimit.mockResolvedValue({ ...AGOTADO, ventana: 0 });

    expect(await enviar()).toBe("/alta?e=falla");

    expect(h.crearInquilino).not.toHaveBeenCalled();
  });
});

describe("cuando algo falla", () => {
  it("si Better Auth no puede crear la cuenta vuelve al formulario con «falla» y lo anota", async () => {
    h.signUpEmail.mockRejectedValue(new Error("la base se cayó"));

    expect(await enviar()).toBe(`/alta/correo?t=${token}&e=falla`);

    expect(h.error).toHaveBeenCalledWith({ detalle: "Error" }, "alta.correo_cuenta_no_creada");
    expect(h.marcarVerificado).not.toHaveBeenCalled();
    expect(h.crearInquilino).not.toHaveBeenCalled();
    expect(h.signInEmail).not.toHaveBeenCalled();
  });

  it("un dominio con SSO exigido (el gancho de Better Auth rechaza) vuelve con «falla», sin cuenta a medias", async () => {
    h.signUpEmail.mockRejectedValue(
      new APIError("UNPROCESSABLE_ENTITY", { code: "sso_requerido", message: "sso_requerido" })
    );

    expect(await enviar()).toBe(`/alta/correo?t=${token}&e=falla`);

    expect(h.error).toHaveBeenCalledWith({ detalle: "sso_requerido" }, "alta.correo_cuenta_no_creada");
    expect(h.crearInquilino).not.toHaveBeenCalled();
  });

  it("si la base no puede crear el espacio, la cuenta queda verificada y con sesión, y /alta deja reintentar", async () => {
    h.crearInquilino.mockRejectedValue(new Error("la base se cayó"));

    expect(await enviar()).toBe("/alta?e=falla");

    expect(h.marcarVerificado).toHaveBeenCalledWith(USUARIO);
    expect(h.signInEmail).toHaveBeenCalledTimes(1);
    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "alta.crear_inquilino_fallo");
    expect(h.liberarCupo).toHaveBeenCalledWith(CLAVE_DEL_CUPO, 24 * 60 * 60_000, 7);
  });

  it("si el alta se cerró (tope del día), la cuenta queda verificada y con sesión, sin espacio", async () => {
    h.crearInquilino.mockResolvedValue(alta("alta_cerrada", { creadas24h: 20, tope: 20 }));

    expect(await enviar()).toBe("/alta?e=cerrada");

    expect(h.marcarVerificado).toHaveBeenCalledWith(USUARIO);
    expect(h.signInEmail).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith({ creadas24h: 20, tope: 20 }, "alta.cerrada");
    expect(h.avisarAlOperador).not.toHaveBeenCalled();
    expect(h.liberarCupo).toHaveBeenCalledWith(CLAVE_DEL_CUPO, 24 * 60 * 60_000, 7);
  });

  it.each([
    ["no_verificado", "/alta?e=falla"],
    ["datos_invalidos", "/alta?e=datos"],
    ["ya_tiene_espacio", "/bandeja"],
  ])("el resultado %s sigue a %s, con la sesión abierta", async (resultado, destino) => {
    h.crearInquilino.mockResolvedValue(alta(resultado));

    expect(await enviar()).toBe(destino);

    expect(h.signInEmail).toHaveBeenCalledTimes(1);
    expect(h.pendientes).toHaveLength(0);
    expect(h.liberarCupo).toHaveBeenCalledTimes(1);
  });

  it("si no se puede abrir la sesión va al login: la cuenta existe y entra con su contraseña", async () => {
    h.signInEmail.mockRejectedValue(new Error("no entró"));

    expect(await enviar()).toBe("/login");

    expect(h.crearInquilino).toHaveBeenCalledTimes(1);
    expect(h.error).toHaveBeenCalledWith({ detalle: "Error" }, "alta.correo_sin_sesion");
  });
});
