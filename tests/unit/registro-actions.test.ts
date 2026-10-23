/**
 * Las acciones de /registro: `signUp` (por correo) y `empezarAltaConGoogle`.
 * /registro es el primer paso del alta y crea sólo la cuenta: nombre, correo y
 * términos. La empresa y el WhatsApp se piden después, en /alta.
 *
 * Lo que se prueba es lo que importa de afuera hacia adentro:
 *   - `signUp` NO crea nada: no llama a `signUpEmail`, no escribe ninguna fila (la
 *     base de la prueba sólo sabe leer) y termina siempre en el mismo aviso;
 *   - lo que depende de la dirección corre en `after`, y de ahí sale el mail
 *     correcto: «Activar tu cuenta» con un enlace que abre con el nombre y el
 *     correo (y nada más), o «Ya tenés cuenta» con los dos caminos para entrar;
 *   - el orden de los controles: `auth:up`, tope por IP, Turnstile y recién
 *     entonces el tope del día de la red;
 *   - el desafío de Turnstile sólo existe con las dos claves, y sólo frena el correo;
 *   - Google no deja ninguna cookie: vuelve a /alta, donde se elige qué hacer, y
 *     el `redirect` va afuera de todo try/catch.
 *
 * Que dos finales no se distingan desde afuera lo repite `registro-no-enumera.test.ts`
 * desde el punto de vista del atacante.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  signUpEmail: vi.fn(),
  signInSocial: vi.fn(),
  buscar: vi.fn(),
  escribir: vi.fn(),
  rateLimit: vi.fn(),
  topePorIp: vi.fn(),
  dominioExigeSso: vi.fn(),
  enviar: vi.fn(),
  locale: vi.fn(),
  fetch: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  cabeceras: vi.fn(),
  /** Lo que la acción dejó para después de responder (`after`). */
  pendientes: [] as Array<() => unknown>,
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
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (tarea: () => unknown) => {
    h.pendientes.push(tarea);
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { signUpEmail: h.signUpEmail, signInSocial: h.signInSocial } },
}));
vi.mock("@/lib/auth/require-operator", () => ({
  isOperatorEmail: (e: string | null | undefined) => e === "ops@example.com",
}));
// La base sólo sabe leer: cualquier escritura de /registro quedaría anotada en `escribir`.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: h.buscar }) }) }),
    insert: h.escribir,
    update: h.escribir,
    delete: h.escribir,
    execute: h.escribir,
  },
}));
vi.mock("@/lib/i18n/locale", () => ({ getServerLocale: h.locale }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: h.error },
}));
vi.mock("@/lib/rate-limit/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/index")>()),
  rateLimit: h.rateLimit,
  topePorIp: h.topePorIp,
}));
vi.mock("@/server/notify/remitente-sistema", () => ({ enviarCorreoDelSistema: h.enviar }));
vi.mock("@/server/sso/usuarios", () => ({ dominioExigeSsoEnAlgunInquilino: h.dominioExigeSso }));

import { getT } from "@/lib/i18n";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { abrirToken } from "@/server/alta/token-de-registro";

const SECRETO = "fake-secreto-del-registro-0123456789";
const BASE = "https://app.example.com";
const AVISO = "/login?aviso=revisa_tu_correo";
const IP = "203.0.113.7";
const LIBRE = { allowed: true, remaining: 2, resetAt: 0, retryAfterSeconds: 0 };
const AGOTADO = { allowed: false, remaining: 0, resetAt: 0, retryAfterSeconds: 3600 };
const URL_DE_GOOGLE = "https://accounts.example.com/o/oauth2/v2/auth?state=fake-estado";

const BUENOS = {
  terminos: "on",
  full_name: "Ana Pérez",
  email: "Ana@Example.com",
};

function formulario(campos: Record<string, string | undefined>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) if (v !== undefined) fd.set(k, v);
  return fd;
}

/** Corre lo que la acción dejó para después de responder. */
const correrLoDiferido = () => Promise.all(h.pendientes.splice(0).map((tarea) => tarea()));

/** Corre la acción y devuelve adónde redirigió. Con `diferido: false` no corre lo posterior a la respuesta. */
async function pedir(
  campos: Record<string, string | undefined> = BUENOS,
  diferido = true
): Promise<string> {
  const { signUp } = await import("@/app/registro/actions");
  try {
    await signUp(formulario(campos));
  } catch (e) {
    if (e instanceof RedirigioA) {
      if (diferido) await correrLoDiferido();
      return e.destino;
    }
    throw e;
  }
  throw new Error("signUp no redirigió");
}

async function conGoogle(campos: Record<string, string | undefined> = { terminos: "on" }): Promise<string> {
  const { empezarAltaConGoogle } = await import("@/app/registro/actions");
  try {
    await empezarAltaConGoogle(formulario(campos));
  } catch (e) {
    if (e instanceof RedirigioA) return e.destino;
    throw e;
  }
  throw new Error("empezarAltaConGoogle no redirigió");
}

/** El mail que salió, con el enlace de activación si lo tiene. */
function elMail() {
  expect(h.enviar).toHaveBeenCalledTimes(1);
  const correo = h.enviar.mock.calls[0][0] as { to: string; asunto: string; texto: string };
  const token = /\/alta\/correo\?t=([A-Za-z0-9._-]+)/.exec(correo.texto)?.[1];
  return { ...correo, token };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.pendientes.length = 0;
  process.env.BETTER_AUTH_SECRET = SECRETO;
  process.env.NEXT_PUBLIC_SITE_URL = BASE;
  process.env.ALTA_AUTOMATICA = "1";
  delete process.env.SIGNUP_ALLOWED_EMAILS;
  delete process.env.ADMIN_EMAILS;
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  vi.stubGlobal("fetch", h.fetch);
  h.cabeceras.mockImplementation(() => new Headers({ "x-forwarded-for": IP }));
  h.locale.mockResolvedValue("es-AR");
  h.rateLimit.mockResolvedValue(LIBRE);
  h.topePorIp.mockResolvedValue(LIBRE);
  h.buscar.mockResolvedValue([]);
  h.dominioExigeSso.mockResolvedValue(false);
  h.enviar.mockResolvedValue({ enviado: true });
  h.signInSocial.mockResolvedValue({ url: URL_DE_GOOGLE, redirect: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.ALTA_AUTOMATICA;
  delete process.env.ALTA_NUMERO_AUTOMATICO;
});

describe("signUp no crea nada", () => {
  it("una dirección nueva termina en el aviso y NUNCA llama a signUpEmail", async () => {
    expect(await pedir()).toBe(AVISO);

    expect(h.signUpEmail).not.toHaveBeenCalled();
    expect(h.escribir).not.toHaveBeenCalled();
  });

  it("una que ya tiene cuenta tampoco", async () => {
    h.buscar.mockResolvedValue([{ id: "u-1" }]);

    expect(await pedir()).toBe(AVISO);

    expect(h.signUpEmail).not.toHaveBeenCalled();
    expect(h.escribir).not.toHaveBeenCalled();
  });

  it("lo único que se asienta son los cupos del limitador", async () => {
    await pedir();

    expect(h.rateLimit).toHaveBeenCalledTimes(2);
    expect(h.topePorIp).toHaveBeenCalledTimes(1);
    expect(h.escribir).not.toHaveBeenCalled();
  });
});

describe("signUp: la dirección nueva", () => {
  it("recibe «Activar tu cuenta» con un enlace que abre con el nombre y el correo", async () => {
    await pedir();
    const mail = elMail();

    expect(mail.to).toBe("ana@example.com");
    expect(mail.asunto).toBe(getT("es-AR")("correo.activar.asunto"));
    expect(mail.token).toBeDefined();
    expect(mail.texto).toContain(`${BASE}/alta/correo?t=${mail.token}`);

    const datos = abrirToken(mail.token);
    expect(datos).toMatchObject({ e: "ana@example.com", nombre: "Ana Pérez", locale: "es-AR" });
  });

  it("el enlace sellado no lleva la empresa ni el número: sólo {e, nombre, locale, exp}", async () => {
    await pedir();
    const datos = abrirToken(elMail().token);

    expect(Object.keys(datos ?? {}).sort()).toEqual(["e", "exp", "locale", "nombre"]);
  });

  it("un formulario viejo con empresa y WhatsApp se acepta, pero esos campos no viajan", async () => {
    expect(
      await pedir({ ...BUENOS, empresa: "Seguros del Sur", whatsapp: "+54 9 (291) 642-6930" })
    ).toBe(AVISO);

    const mail = elMail();
    expect(Object.keys(abrirToken(mail.token) ?? {}).sort()).toEqual(["e", "exp", "locale", "nombre"]);
    expect(mail.texto).not.toContain("Seguros del Sur");
  });

  it("en inglés, el mail y el enlace salen en inglés", async () => {
    h.locale.mockResolvedValue("en-US");

    await pedir();
    const mail = elMail();

    expect(mail.asunto).toBe(getT("en-US")("correo.activar.asunto"));
    expect(abrirToken(mail.token)?.locale).toBe("en-US");
  });

  it("el saludo no lleva el nombre que escribió quien pidió el alta", async () => {
    await pedir();

    expect(elMail().texto).not.toContain("Pérez");
  });

  it("el enlace vence en una hora y el mail lo dice", async () => {
    await pedir();

    expect(elMail().texto).toContain(getT("es-AR")("correo.enlace.vence").replace("{minutos}", "60"));
  });

  it("lo que depende de la dirección corre DESPUÉS de responder", async () => {
    expect(await pedir(BUENOS, false)).toBe(AVISO);

    expect(h.buscar).not.toHaveBeenCalled();
    expect(h.dominioExigeSso).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();

    await correrLoDiferido();

    expect(h.buscar).toHaveBeenCalledTimes(1);
    expect(h.enviar).toHaveBeenCalledTimes(1);
  });
});

describe("signUp: la dirección que ya tiene cuenta", () => {
  beforeEach(() => {
    h.buscar.mockResolvedValue([{ id: "u-1" }]);
  });

  it("recibe «Ya tenés cuenta» con los enlaces a /login y /recuperar, y el MISMO redirect", async () => {
    const destino = await pedir();
    const mail = elMail();

    expect(destino).toBe(AVISO);
    expect(mail.to).toBe("ana@example.com");
    expect(mail.asunto).toBe(getT("es-AR")("correo.yaTenes.asunto"));
    expect(mail.texto).toContain(`${BASE}/login`);
    expect(mail.texto).toContain(`${BASE}/recuperar`);
  });

  it("y no lleva ningún enlace de activación", async () => {
    await pedir();

    expect(elMail().texto).not.toContain("/alta/correo");
  });

  it("le avisa aunque el alta esté cerrada: el mail es para su dueña", async () => {
    delete process.env.ALTA_AUTOMATICA;

    await pedir();

    expect(elMail().asunto).toBe(getT("es-AR")("correo.yaTenes.asunto"));
  });

  it("pregunta por la cuenta una sola vez", async () => {
    await pedir();

    expect(h.buscar).toHaveBeenCalledTimes(1);
  });
});

describe("signUp: lo que no manda ningún mail, con el mismo final", () => {
  it("con el alta cerrada para la dirección", async () => {
    delete process.env.ALTA_AUTOMATICA;
    process.env.SIGNUP_ALLOWED_EMAILS = "@otra-empresa.example.com";

    expect(await pedir()).toBe(AVISO);
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("con la dirección en la lista, sin ALTA_AUTOMATICA, sí sale", async () => {
    delete process.env.ALTA_AUTOMATICA;
    process.env.SIGNUP_ALLOWED_EMAILS = "@example.com";

    await pedir();

    expect(h.enviar).toHaveBeenCalledTimes(1);
  });

  it("con una dirección de operación", async () => {
    expect(await pedir({ ...BUENOS, email: "ops@example.com" })).toBe(AVISO);
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("con un dominio que exige SSO", async () => {
    h.dominioExigeSso.mockResolvedValue(true);

    expect(await pedir()).toBe(AVISO);
    expect(h.dominioExigeSso).toHaveBeenCalledWith("ana@example.com");
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it.each([
    ["sin remitente", { enviado: false, motivo: "sin_remitente" }],
    ["sin cupo", { enviado: false, motivo: "sin_cupo" }],
    ["sin que el mail salga", { enviado: false, motivo: "no_salio" }],
  ])("%s: el mismo final, y queda anotado", async (_caso, resultado) => {
    h.enviar.mockResolvedValue(resultado);

    expect(await pedir()).toBe(AVISO);
    expect(h.warn).toHaveBeenCalledWith({ motivo: resultado.motivo }, "registro.correo_no_salio");
  });

  it("una falla de la base en lo diferido no cambia la respuesta y deja rastro", async () => {
    h.buscar.mockRejectedValue(new Error("la base se cayó"));

    expect(await pedir()).toBe(AVISO);
    expect(h.error).toHaveBeenCalledWith({ detalle: "Error" }, "registro.alta_no_terminada");
    expect(h.enviar).not.toHaveBeenCalled();
  });
});

describe("signUp: lo que valida y lo que cuenta", () => {
  it.each([
    ["sin términos", { terminos: undefined }],
    ["con los términos en otra cosa que «on»", { terminos: "true" }],
    ["sin nombre", { full_name: "" }],
    ["sin correo", { email: "" }],
    ["con un correo que no es un correo", { email: "no-es-un-correo" }],
  ])("%s va a /registro?e=datos, sin gastar cupo ni mandar nada", async (_caso, cambio) => {
    expect(await pedir({ ...BUENOS, ...cambio })).toBe("/registro?e=datos");

    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.topePorIp).not.toHaveBeenCalled();
    expect(h.pendientes).toHaveLength(0);
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("ya no pide la empresa ni el WhatsApp: sin ellos el pedido sigue", async () => {
    expect(await pedir({ terminos: "on", full_name: "Ana Pérez", email: "ana@example.com" })).toBe(AVISO);

    expect(h.enviar).toHaveBeenCalledTimes(1);
  });

  it("y no mira lo que haya en esos campos: ni «celular» ni «datos» por ellos", async () => {
    process.env.ALTA_NUMERO_AUTOMATICO = "1";

    expect(await pedir({ ...BUENOS, empresa: "", whatsapp: "+54 11 1234-5678" })).toBe(AVISO);
    expect(await conGoogle({ terminos: "on", empresa: "", whatsapp: "+54 11 1234-5678" })).toBe(URL_DE_GOOGLE);
  });

  it("cuenta `auth:up` y el tope por IP, con la IP de la red", async () => {
    await pedir();

    expect(h.rateLimit).toHaveBeenCalledWith(claveDeCupo("auth:up", IP), RATE_LIMIT_CONFIGS.AUTH_SIGN_UP);
    expect(h.topePorIp).toHaveBeenCalledWith(IP);
  });

  it("dos direcciones del mismo /64 comparten cupo", async () => {
    h.cabeceras.mockImplementation(() => new Headers({ "x-forwarded-for": "2001:db8:abcd:12:1111:2222:3333:4444" }));
    await pedir();
    h.cabeceras.mockImplementation(() => new Headers({ "x-forwarded-for": "2001:db8:abcd:12:aaaa:bbbb:cccc:dddd" }));
    await pedir();

    const [primera, segunda] = h.rateLimit.mock.calls.map((c) => c[0]).filter((c) => c.startsWith("auth:up:"));
    expect(primera).toBe(segunda);
    expect(primera).toBe("auth:up:2001:db8:abcd:12::/64");
  });

  it("cuenta también los pedidos del día de esa red (`alta:correo-ip`), por /56 en IPv6", async () => {
    await pedir();
    h.cabeceras.mockImplementation(() => new Headers({ "x-forwarded-for": "2001:db8:abcd:12:1111:2222:3333:4444" }));
    await pedir();

    expect(h.rateLimit).toHaveBeenCalledWith(claveDeCupo("alta:correo-ip", IP), {
      limit: 10,
      windowMs: 24 * 60 * 60_000,
      fallaCerrada: true,
    });
    expect(h.rateLimit).toHaveBeenCalledWith("alta:correo-ip:2001:db8:abcd:0::/56", expect.anything());
  });

  it("agotado el tope del día de esa red: /registro?e=intentos, sin mail", async () => {
    h.rateLimit.mockImplementation(async (clave: string) => (clave.startsWith("alta:correo-ip:") ? AGOTADO : LIBRE));

    expect(await pedir()).toBe("/registro?e=intentos");
    expect(h.pendientes).toHaveLength(0);
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("el tope del día de esa red no se gasta con un desafío de Turnstile no pasado", async () => {
    process.env.TURNSTILE_SITE_KEY = "test-turnstile-site-key";
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret-key";
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 200 }));

    expect(await pedir({ ...BUENOS, "cf-turnstile-response": "fake-respuesta-del-desafio" })).toBe(AVISO);

    expect(h.rateLimit.mock.calls.map((c) => c[0])).toEqual([claveDeCupo("auth:up", IP)]);
  });

  it("el orden de los controles: `auth:up`, tope por IP, Turnstile y el tope del día de la red", async () => {
    process.env.TURNSTILE_SITE_KEY = "test-turnstile-site-key";
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret-key";
    const orden: string[] = [];
    h.rateLimit.mockImplementation(async (clave: string) => {
      orden.push(clave.split(":").slice(0, 2).join(":"));
      return LIBRE;
    });
    h.topePorIp.mockImplementation(async () => {
      orden.push("topePorIp");
      return LIBRE;
    });
    h.fetch.mockImplementation(async () => {
      orden.push("turnstile");
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    expect(await pedir({ ...BUENOS, "cf-turnstile-response": "fake-respuesta-del-desafio" })).toBe(AVISO);

    expect(orden).toEqual(["auth:up", "topePorIp", "turnstile", "alta:correo-ip"]);
  });

  it("el mail sale con el tipo `alta` y la IP de la red, para sus cupos", async () => {
    await pedir();

    expect(h.enviar).toHaveBeenCalledWith(expect.anything(), { tipo: "alta", ip: IP });
  });

  it("«ya tenés cuenta» también cuenta como `alta`: no se distingue por el cupo", async () => {
    h.buscar.mockResolvedValue([{ id: "u-1" }]);
    await pedir();

    expect(h.enviar).toHaveBeenCalledWith(expect.anything(), { tipo: "alta", ip: IP });
  });

  it("sin cupo de `auth:up`: /registro?e=intentos, sin mail", async () => {
    h.rateLimit.mockResolvedValue(AGOTADO);

    expect(await pedir()).toBe("/registro?e=intentos");
    expect(h.pendientes).toHaveLength(0);
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("sin cupo por IP: /registro?e=intentos, sin mail", async () => {
    h.topePorIp.mockResolvedValue(AGOTADO);

    expect(await pedir()).toBe("/registro?e=intentos");
    expect(h.pendientes).toHaveLength(0);
    expect(h.enviar).not.toHaveBeenCalled();
  });
});

describe("Turnstile", () => {
  const CAMPOS = { ...BUENOS, "cf-turnstile-response": "fake-respuesta-del-desafio" };
  const claves = () => {
    process.env.TURNSTILE_SITE_KEY = "test-turnstile-site-key";
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret-key";
  };
  const cloudflare = (cuerpo: unknown, estado = 200) =>
    h.fetch.mockResolvedValue(new Response(JSON.stringify(cuerpo), { status: estado }));

  it("sin claves no se llama a Cloudflare y el pedido sigue", async () => {
    expect(await pedir()).toBe(AVISO);

    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.enviar).toHaveBeenCalledTimes(1);
  });

  it("con una sola clave tampoco: no hay desafío", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret-key";

    await pedir();

    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.enviar).toHaveBeenCalledTimes(1);
  });

  it("con las dos y Cloudflare de acuerdo, el pedido sigue", async () => {
    claves();
    cloudflare({ success: true });

    expect(await pedir(CAMPOS)).toBe(AVISO);

    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const cuerpo = init.body as URLSearchParams;
    expect(cuerpo.get("secret")).toBe("test-turnstile-secret-key");
    expect(cuerpo.get("response")).toBe("fake-respuesta-del-desafio");
    expect(cuerpo.get("remoteip")).toBe(IP);
    expect(h.enviar).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Cloudflare dice que no", () => cloudflare({ success: false })],
    ["Cloudflare contesta con un error", () => cloudflare({}, 500)],
    ["Cloudflare no contesta", () => h.fetch.mockRejectedValue(new Error("timeout"))],
  ])("con las dos claves, si %s: el mismo aviso y ni un mail", async (_caso, preparar) => {
    claves();
    preparar();

    expect(await pedir(CAMPOS)).toBe(AVISO);

    expect(h.pendientes).toHaveLength(0);
    expect(h.buscar).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("un desafío rechazado se registra como aviso, con el motivo y sin la IP ni la respuesta", async () => {
    claves();
    cloudflare({ success: false, "error-codes": ["timeout-or-duplicate"] });

    expect(await pedir(CAMPOS)).toBe(AVISO);

    expect(h.warn).toHaveBeenCalledWith(
      { motivo: "rechazada", codigos: ["timeout-or-duplicate"] },
      "registro.turnstile_no_paso"
    );
    expect(h.error).not.toHaveBeenCalled();
    const registrado = JSON.stringify(h.warn.mock.calls);
    expect(registrado).not.toContain(IP);
    expect(registrado).not.toContain("fake-respuesta-del-desafio");
    expect(registrado).not.toContain(BUENOS.email);
  });

  it.each(["invalid-input-secret", "missing-input-secret"])(
    "con el código %s la clave está mal cargada: se registra como error",
    async (codigo) => {
      claves();
      cloudflare({ success: false, "error-codes": [codigo] }, 400);

      expect(await pedir(CAMPOS)).toBe(AVISO);

      expect(h.error).toHaveBeenCalledWith(
        { motivo: "cloudflare_error", codigos: [codigo] },
        "registro.turnstile_no_paso"
      );
      expect(h.warn).not.toHaveBeenCalled();
      expect(h.enviar).not.toHaveBeenCalled();
    }
  );

  it("con las dos claves y sin respuesta del desafío: el mismo aviso, sin llamar a Cloudflare", async () => {
    claves();

    expect(await pedir(BUENOS)).toBe(AVISO);

    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("sólo frena el correo: Google sale sin desafío", async () => {
    claves();

    expect(await conGoogle()).toBe(URL_DE_GOOGLE);

    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("empezarAltaConGoogle", () => {
  it("manda a Google y, al volver, a /alta: sin cookie ni nada de lo que haya escrito", async () => {
    expect(await conGoogle()).toBe(URL_DE_GOOGLE);

    expect(h.signInSocial).toHaveBeenCalledTimes(1);
    expect(h.signInSocial).toHaveBeenCalledWith({
      body: {
        provider: "google",
        callbackURL: "/alta",
        newUserCallbackURL: "/alta",
        errorCallbackURL: "/login",
      },
      headers: expect.any(Headers),
    });
  });

  it("las URL de vuelta no llevan parámetros propios", async () => {
    await conGoogle();

    const { body } = h.signInSocial.mock.calls[0][0] as { body: Record<string, string> };
    for (const url of [body.callbackURL, body.newUserCallbackURL, body.errorCallbackURL]) {
      expect(url).not.toContain("?");
    }
  });

  it("el redirect está afuera del try: la URL de Google no se confunde con una falla", async () => {
    expect(await conGoogle()).toBe(URL_DE_GOOGLE);

    expect(h.error).not.toHaveBeenCalled();
  });

  it("no pide nombre ni correo: el nombre y el correo son de Google", async () => {
    expect(await conGoogle({ terminos: "on" })).toBe(URL_DE_GOOGLE);
  });

  it.each([
    ["Better Auth tira", () => h.signInSocial.mockRejectedValue(new Error("sin red"))],
    ["Better Auth no devuelve URL", () => h.signInSocial.mockResolvedValue({ url: undefined })],
  ])("si %s: /login?error=google_signin_failed", async (_caso, preparar) => {
    preparar();

    expect(await conGoogle()).toBe("/login?error=google_signin_failed");
  });

  it("si Better Auth tira, queda anotado", async () => {
    h.signInSocial.mockRejectedValue(new Error("sin red"));

    await conGoogle();

    expect(h.error).toHaveBeenCalledWith({ detalle: "sin red" }, "auth.google.signin_start_failed");
  });

  it.each([
    ["sin términos", { terminos: undefined }],
    ["con los términos en otra cosa que «on»", { terminos: "true" }],
  ])("%s va a /registro?e=terminos, sin Google: es lo único que le puede faltar", async (_caso, cambio) => {
    expect(await conGoogle({ ...cambio })).toBe("/registro?e=terminos");

    expect(h.topePorIp).not.toHaveBeenCalled();
    expect(h.signInSocial).not.toHaveBeenCalled();
  });

  it("sin cupo por IP: /registro?e=intentos, sin Google", async () => {
    h.topePorIp.mockResolvedValue(AGOTADO);

    expect(await conGoogle()).toBe("/registro?e=intentos");
    expect(h.signInSocial).not.toHaveBeenCalled();
  });

  it("cuenta el tope por IP y no manda ningún mail ni escribe ninguna fila", async () => {
    await conGoogle();

    expect(h.topePorIp).toHaveBeenCalledWith(IP);
    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.escribir).not.toHaveBeenCalled();
    expect(h.signUpEmail).not.toHaveBeenCalled();
  });
});
