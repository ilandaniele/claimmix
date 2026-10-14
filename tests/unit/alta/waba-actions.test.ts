/**
 * Las Server Actions de /conectar-whatsapp (`src/app/conectar-whatsapp/actions.ts`).
 *
 * Lo que se prueba es la puerta y lo que se le pasa al flujo, no el flujo (de eso se
 * ocupa `waba-propia.test.ts`):
 *   - sin sesión, sin el rol o con un espacio que no es del alta automática cortan
 *     antes de tocar nada, y cada una pide el rol por su cuenta;
 *   - ninguna action mira las banderas de las dos vías: lo decide el flujo con
 *     `activaPara`, y cancelar o desconectar no lo frena nada (S11);
 *   - las del asistente de la app propia acotan lo que llega antes de gastar un cupo,
 *     y ni el token, ni el secreto, ni la clave del cliente llegan a un registro;
 *   - quién pide sale de la sesión y de los headers, nunca del cuerpo;
 *   - lo que llega del navegador (nombre, web, ids, evento, código, PIN) se acota o
 *     se rechaza antes de llegar al flujo;
 *   - el sello de `iniciarWabaPropia` es de esta sesión, vence a los diez minutos, va
 *     atado a la cookie `cm_waba` y se gasta en el primer uso, valga o no;
 *   - una falla inesperada vuelve «meta», sin que el mensaje llegue al registro.
 */

import { isIP } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  cabeceras: vi.fn(),
  topePorIp: vi.fn(),
  faltantes: vi.fn(),
  rateLimit: vi.fn(),
  liberarCupo: vi.fn(),
  iniciarApp: vi.fn(),
  credencialesApp: vi.fn(),
  webhookApp: vi.fn(),
  tokenApp: vi.fn(),
  nombreApp: vi.fn(),
  estadoApp: vi.fn(),
  reintentarApp: vi.fn(),
  cancelarApp: vi.fn(),
  appDeMeta: vi.fn(),
  iniciar: vi.fn(),
  vincular: vi.fn(),
  aceptar: vi.fn(),
  codigo: vi.fn(),
  pin: vi.fn(),
  cancelar: vi.fn(),
  desconectar: vi.fn(),
  error: vi.fn(),
  galletas: new Map<string, string>(),
  galletaPuesta: vi.fn(),
  galletaBorrada: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => h.cabeceras(),
  cookies: async () => ({
    get: (nombre: string) => (h.galletas.has(nombre) ? { name: nombre, value: h.galletas.get(nombre) } : undefined),
    set: (nombre: string, valor: string, opciones: unknown) => {
      h.galletaPuesta(nombre, valor, opciones);
      h.galletas.set(nombre, valor);
    },
    delete: (opciones: { name: string; path?: string }) => {
      h.galletaBorrada(opciones);
      h.galletas.delete(opciones.name);
    },
  }),
}));
vi.mock("@/lib/audit/log", () => ({ ipValida: (ip?: string | null) => (ip && isIP(ip) !== 0 ? ip : null) }));
vi.mock("@/lib/auth/require-role", () => ({ ADMIN_ROLES: ["owner", "admin"], requireRole: h.requireRole }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: h.error },
}));
vi.mock("@/lib/rate-limit/index", () => ({
  clientIpFromHeaders: (cabeceras: Headers) => cabeceras.get("x-forwarded-for"),
  topePorIp: h.topePorIp,
  rateLimit: h.rateLimit,
  liberarCupo: h.liberarCupo,
  RATE_LIMIT_CONFIGS: {
    APP_PROPIA: { limit: 10, windowMs: 3_600_000 },
    APP_PROPIA_INICIO: { limit: 3, windowMs: 86_400_000, fallaCerrada: true },
    ESTADO_APP: { limit: 120, windowMs: 60_000, lote: 10 },
  },
}));
vi.mock("@/server/alta/waba-propia", () => ({
  iniciarWaba: h.iniciar,
  vincularWaba: h.vincular,
  aceptarNumero: h.aceptar,
  codigoWaba: h.codigo,
  pinWaba: h.pin,
  cancelarWaba: h.cancelar,
  desconectarWaba: h.desconectar,
}));
vi.mock("@/server/alta/app-propia", () => ({
  iniciarApp: h.iniciarApp,
  credencialesDeApp: h.credencialesApp,
  webhookDeApp: h.webhookApp,
  tokenDeApp: h.tokenApp,
  nombreDeApp: h.nombreApp,
  estadoDeApp: h.estadoApp,
  reintentarDeApp: h.reintentarApp,
  cancelarDeApp: h.cancelarApp,
}));
vi.mock("@/server/alta/waba-propia-activa", () => ({ faltantesDeAppPropia: h.faltantes }));
vi.mock("@/server/whatsapp/cloud-api", () => ({ versionDeGraph: () => "v99.0" }));
vi.mock("@/server/whatsapp/embedded-signup", () => ({ appDeMeta: h.appDeMeta }));

import * as todas from "@/app/conectar-whatsapp/actions";
import {
  aceptarNumeroDeMeta,
  cancelacionDeWabaPropia,
  cancelarAppPropia,
  codigoDeWabaPropia,
  conectarWabaPropia,
  credencialesDeAppPropia,
  desconectarWabaPropia,
  estadoDeAppPropia,
  iniciarAppPropia,
  iniciarWabaPropia,
  nombreDeAppPropia,
  pinDeWabaPropia,
  reintentarWabaPropia,
  tokenDeAppPropia,
  webhookDeAppPropia,
} from "@/app/conectar-whatsapp/actions";
import { AppError } from "@/lib/errors";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { CATEGORIAS_DE_PERFIL } from "@/lib/whatsapp-categorias";
import { abrir, sellar } from "@/server/alta/sellado";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USUARIO = "22222222-2222-4222-8222-222222222222";
const OTRO_USUARIO = "33333333-3333-4333-8333-333333333333";
const IP = "203.0.113.7";
const SETUP = { business: { name: "Seguros Sur" }, phone: { displayName: "Seguros Sur" } };
const ESTADO = {
  paso: "P1",
  estado: "armando",
  falla: null,
  appId: null,
  webhookVerificado: false,
  datosApp: false,
  numero: null,
  nombreEstado: null,
  plantilla: false,
  primerMensaje: false,
  primeraRespuesta: false,
  puedeEnviar: null,
};
const DIEZ_MINUTOS = 10 * 60_000;
const SECRETO = "test-waba-auth-secret-key";
const QUIEN = { tenantId: TENANT, userId: USUARIO, ip: IP, idioma: "es-AR" };
const VENTANA = 7;
const WEBHOOK = { url: "https://claimmix.example.com/api/webhooks/whatsapp/app/fake-ruta", verifyToken: "fake-verify-token", aviso: null };

function fila(cambios: Record<string, unknown> = {}) {
  return { userRow: { id: USUARIO, tenant_id: TENANT, role: "owner", autoalta: true, locale: "es-AR", ...cambios } };
}

const secretoAnterior = process.env.BETTER_AUTH_SECRET;
const appPropiaAnterior = process.env.ALTA_APP_PROPIA;

beforeEach(() => {
  vi.clearAllMocks();
  h.galletas.clear();
  process.env.BETTER_AUTH_SECRET = SECRETO;
  delete process.env.ALTA_APP_PROPIA;
  h.faltantes.mockReturnValue([]);
  h.rateLimit.mockResolvedValue({ allowed: true, ventana: VENTANA });
  h.liberarCupo.mockResolvedValue(undefined);
  h.requireRole.mockResolvedValue(fila());
  h.cabeceras.mockReturnValue(new Headers({ "x-forwarded-for": IP }));
  h.topePorIp.mockResolvedValue({ allowed: true });
  h.appDeMeta.mockReturnValue({ appId: "fake-app-id", configId: "fake-config-id" });
  h.iniciar.mockResolvedValue({ resultado: "listo", setup: SETUP });
  h.vincular.mockResolvedValue({ resultado: "conectado" });
  h.aceptar.mockResolvedValue("conectado");
  h.codigo.mockResolvedValue("codigo_enviado");
  h.pin.mockResolvedValue("conectado");
  h.reintentarApp.mockResolvedValue("conectado");
  h.iniciarApp.mockResolvedValue({ resultado: "listo" });
  h.credencialesApp.mockResolvedValue({ resultado: "listo" });
  h.webhookApp.mockResolvedValue({ resultado: "listo", webhook: WEBHOOK });
  h.tokenApp.mockResolvedValue({ resultado: "conectado" });
  h.nombreApp.mockResolvedValue({ resultado: "listo" });
  h.estadoApp.mockResolvedValue(ESTADO);
  h.cancelar.mockResolvedValue("cancelado");
  h.cancelarApp.mockResolvedValue("cancelado");
  h.desconectar.mockResolvedValue("desconectado");
});

afterEach(() => {
  vi.useRealTimers();
  if (appPropiaAnterior === undefined) delete process.env.ALTA_APP_PROPIA;
  else process.env.ALTA_APP_PROPIA = appPropiaAnterior;
  if (secretoAnterior === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = secretoAnterior;
});

/** Abre el alta como lo haría la pantalla y devuelve el sello; la cookie queda puesta. */
async function iniciar(): Promise<string> {
  const r = await iniciarWabaPropia({ nombre: "Seguros Sur" });
  if (!r.inicio) throw new Error("iniciar no dejó el sello");
  return r.inicio;
}

const NINGUNA_DEL_FLUJO = () => [
  h.iniciar,
  h.vincular,
  h.aceptar,
  h.codigo,
  h.pin,
  h.reintentarApp,
  h.cancelar,
  h.cancelarApp,
  h.desconectar,
  h.iniciarApp,
  h.credencialesApp,
  h.webhookApp,
  h.tokenApp,
  h.nombreApp,
  h.estadoApp,
];

const ACCIONES: Array<[string, () => Promise<{ resultado: string }>]> = [
  ["iniciarWabaPropia", () => iniciarWabaPropia({ nombre: "Seguros Sur" })],
  ["conectarWabaPropia", () => conectarWabaPropia({ inicio: "x", code: "fake-popup-code" })],
  ["aceptarNumeroDeMeta", () => aceptarNumeroDeMeta()],
  ["codigoDeWabaPropia", () => codigoDeWabaPropia({ accion: "SMS" })],
  ["pinDeWabaPropia", () => pinDeWabaPropia({ pin: "482915" })],
  ["reintentarWabaPropia", () => reintentarWabaPropia()],
  ["cancelacionDeWabaPropia", () => cancelacionDeWabaPropia({ paso: "permissions" })],
  ["desconectarWabaPropia", () => desconectarWabaPropia()],
  ["cancelarAppPropia", () => cancelarAppPropia()],
  ["iniciarAppPropia", () => iniciarAppPropia({ acuerdo: "2026-10", razonSocial: "Seguros Sur SA", cuit: "30-71234567-1" })],
  ["credencialesDeAppPropia", () => credencialesDeAppPropia({ appId: "100000000000555", secreto: "fake-app-secret-value" })],
  ["webhookDeAppPropia", () => webhookDeAppPropia()],
  ["tokenDeAppPropia", () => tokenDeAppPropia({ token: "fake-system-user-token", wabaId: "200000000000001" })],
  ["nombreDeAppPropia", () => nombreDeAppPropia({ nombre: "Seguros Sur" })],
  ["estadoDeAppPropia", async () => (await estadoDeAppPropia()) as { resultado: string }],
];

describe.each(ACCIONES)("%s: la puerta", (_nombre, accion) => {
  it("pide owner o admin por su cuenta", async () => {
    await accion();

    expect(h.requireRole).toHaveBeenCalledWith("owner", "admin");
  });

  it("sin sesión contesta «vencido» y no toca el flujo", async () => {
    h.requireRole.mockRejectedValue(new AppError("MISSING_SESSION"));

    expect(await accion()).toEqual({ resultado: "vencido" });

    for (const f of NINGUNA_DEL_FLUJO()) expect(f).not.toHaveBeenCalled();
  });

  it("sin el rol contesta «revision» y no toca el flujo", async () => {
    h.requireRole.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    expect(await accion()).toEqual({ resultado: "revision" });

    for (const f of NINGUNA_DEL_FLUJO()) expect(f).not.toHaveBeenCalled();
  });

  it("un espacio que no es del alta automática contesta «revision» y no toca el flujo", async () => {
    h.requireRole.mockResolvedValue(fila({ autoalta: false }));

    expect(await accion()).toEqual({ resultado: "revision" });

    for (const f of NINGUNA_DEL_FLUJO()) expect(f).not.toHaveBeenCalled();
  });

  it("un fallo de la sesión que no es de sesión también corta, sin dejar pasar", async () => {
    h.requireRole.mockRejectedValue(new TypeError("la base no contesta"));

    expect(await accion()).toEqual({ resultado: "revision" });

    for (const f of NINGUNA_DEL_FLUJO()) expect(f).not.toHaveBeenCalled();
  });
});

describe("las banderas de las dos vías", () => {
  const APAGADO = { resultado: "apagado" };
  it.each([
    ["iniciarWabaPropia", () => iniciarWabaPropia({ nombre: "Seguros Sur" }), h.iniciar, APAGADO],
    ["conectarWabaPropia", async () => conectarWabaPropia({ inicio: await iniciar(), code: "fake-popup-code" }), h.vincular, APAGADO],
    ["aceptarNumeroDeMeta", () => aceptarNumeroDeMeta(), h.aceptar, "apagado"],
    ["codigoDeWabaPropia", () => codigoDeWabaPropia({ accion: "SMS" }), h.codigo, "apagado"],
    ["pinDeWabaPropia", () => pinDeWabaPropia({ pin: "482915" }), h.pin, "apagado"],
    ["reintentarWabaPropia", () => reintentarWabaPropia(), h.reintentarApp, "apagado"],
  ] as const)("%s: la bandera la mira el flujo, y lo que contesta «apagado» llega tal cual", async (_nombre, accion, flujo, devuelve) => {
    flujo.mockResolvedValue(devuelve);

    expect(await accion()).toEqual(APAGADO);
  });

  it.each([
    ["cancelacionDeWabaPropia", () => cancelacionDeWabaPropia({ paso: "permissions" }), h.cancelar, "cancelado"],
    ["desconectarWabaPropia", () => desconectarWabaPropia(), h.desconectar, "desconectado"],
    ["cancelarAppPropia", () => cancelarAppPropia(), h.cancelarApp, "cancelado"],
  ] as const)("%s: soltar lo que ya se tiene no lo frena ninguna bandera (S11)", async (_nombre, accion, flujo, resultado) => {
    process.env.ALTA_APP_PROPIA = "1";
    h.faltantes.mockReturnValue(["META_APP_ID", "WHATSAPP_APP_SECRETS_KEY"]);

    expect(await accion()).toEqual({ resultado });

    expect(flujo).toHaveBeenCalledTimes(1);
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
  });

  it("con la app propia pedida y sin configuración, lo anota una vez por proceso, con los nombres y sin valores", async () => {
    vi.resetModules();
    process.env.ALTA_APP_PROPIA = "1";
    h.faltantes.mockReturnValue(["NEXT_PUBLIC_SITE_URL", "WHATSAPP_APP_SECRETS_KEY"]);
    const nueva = await import("@/app/conectar-whatsapp/actions");

    await nueva.credencialesDeAppPropia({ appId: "100000000000555", secreto: "fake-app-secret-value" });
    await nueva.nombreDeAppPropia({ nombre: "Seguros Sur" });
    await nueva.iniciarAppPropia({ acuerdo: "2026-10", razonSocial: "Seguros Sur SA", cuit: "30-71234567-1" });

    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.error).toHaveBeenCalledWith({ faltan: ["NEXT_PUBLIC_SITE_URL", "WHATSAPP_APP_SECRETS_KEY"] }, "alta.app_propia_sin_config");
    expect(JSON.stringify(h.error.mock.calls)).not.toContain("fake-app-secret-value");
  });

  it("con la bandera de la app propia apagada no anota nada ni mira la configuración", async () => {
    vi.resetModules();
    const nueva = await import("@/app/conectar-whatsapp/actions");

    await nueva.credencialesDeAppPropia({ appId: "100000000000555", secreto: "fake-app-secret-value" });

    expect(h.faltantes).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
  });

  it("con la app propia pedida y la configuración completa tampoco anota", async () => {
    vi.resetModules();
    process.env.ALTA_APP_PROPIA = "1";
    const nueva = await import("@/app/conectar-whatsapp/actions");

    await nueva.webhookDeAppPropia();

    expect(h.error).not.toHaveBeenCalled();
  });
});

describe("lo que exporta", () => {
  it("son sólo las acciones: nada más puede ser un POST", () => {
    expect(Object.keys(todas).sort()).toEqual(
      [
        "aceptarNumeroDeMeta",
        "cancelacionDeWabaPropia",
        "cancelarAppPropia",
        "codigoDeWabaPropia",
        "conectarWabaPropia",
        "credencialesDeAppPropia",
        "desconectarWabaPropia",
        "estadoDeAppPropia",
        "iniciarAppPropia",
        "iniciarWabaPropia",
        "nombreDeAppPropia",
        "pinDeWabaPropia",
        "reintentarWabaPropia",
        "tokenDeAppPropia",
        "webhookDeAppPropia",
      ].sort()
    );
  });

  it("no hay una acción que devuelva los datos guardados de la app (el secreto no vuelve nunca)", () => {
    expect(todas).not.toHaveProperty("datosDeAppPropia");
  });
});

describe("quién pide", () => {
  it("sale de la sesión y de los headers, no del cuerpo", async () => {
    await cancelacionDeWabaPropia({ paso: "permissions", tenantId: "otro", userId: "otro", ip: "198.51.100.1" } as never);

    expect(h.cancelar).toHaveBeenCalledWith({ tenantId: TENANT, userId: USUARIO, ip: IP, idioma: "es-AR" }, "permissions", undefined);
  });

  it("el idioma es en-US sólo si el usuario lo tiene; cualquier otro valor es es-AR", async () => {
    h.requireRole.mockResolvedValue(fila({ locale: "en-US" }));
    await desconectarWabaPropia();
    h.requireRole.mockResolvedValue(fila({ locale: "pt-BR" }));
    await desconectarWabaPropia();

    expect(h.desconectar.mock.calls.map(([q]) => (q as { idioma: string }).idioma)).toEqual(["en-US", "es-AR"]);
  });

  it("una IP que no es una IP no entra: queda en null", async () => {
    h.cabeceras.mockReturnValue(new Headers({ "x-forwarded-for": "no-es-una-ip" }));

    await desconectarWabaPropia();

    expect(h.desconectar).toHaveBeenCalledWith(expect.objectContaining({ ip: null }));
  });

  it("lo que tira el flujo vuelve «meta» y sólo se anota el nombre del error", async () => {
    h.desconectar.mockRejectedValue(new RangeError("detalle con fake-client-access-token"));

    expect(await desconectarWabaPropia()).toEqual({ resultado: "meta" });

    expect(h.error).toHaveBeenCalledWith({ error: "RangeError" }, "conectar_whatsapp.waba_accion_fallo");
    expect(JSON.stringify(h.error.mock.calls)).not.toContain("fake-client-access-token");
  });

  it("un valor que se tira sin ser un Error se anota como UnknownError", async () => {
    h.desconectar.mockRejectedValue("texto");

    expect(await desconectarWabaPropia()).toEqual({ resultado: "meta" });

    expect(h.error).toHaveBeenCalledWith({ error: "UnknownError" }, "conectar_whatsapp.waba_accion_fallo");
  });
});

describe("iniciarWabaPropia", () => {
  it("deja el popup listo: el sello, la app, el config, la versión de Graph y lo que se precarga", async () => {
    const r = await iniciarWabaPropia({ nombre: "Seguros Sur", web: "https://seguros.example.com" });

    expect(r).toEqual({
      resultado: "listo",
      inicio: expect.any(String),
      appId: "fake-app-id",
      configId: "fake-config-id",
      version: "v99.0",
      setup: SETUP,
    });
    expect(h.iniciar).toHaveBeenCalledWith({ tenantId: TENANT, userId: USUARIO, ip: IP, idioma: "es-AR" }, { nombre: "Seguros Sur", web: "https://seguros.example.com" });
  });

  it("el nombre se recorta, y sin sitio web no se pasa la clave", async () => {
    await iniciarWabaPropia({ nombre: "  Seguros Sur  " });

    expect(h.iniciar.mock.calls[0][1]).toEqual({ nombre: "Seguros Sur" });
    expect(h.iniciar.mock.calls[0][1]).not.toHaveProperty("web");
  });

  it.each(CATEGORIAS_DE_PERFIL)("el rubro %s de la lista de Meta se pasa tal cual", async (categoria) => {
    await iniciarWabaPropia({ nombre: "Seguros Sur", categoria });

    expect(h.iniciar.mock.calls[0][1]).toEqual({ nombre: "Seguros Sur", categoria });
  });

  it("sin rubro no se pasa la clave: `iniciarWaba` pone el inicial", async () => {
    await iniciarWabaPropia({ nombre: "Seguros Sur", web: "https://seguros.example.com" });

    expect(h.iniciar.mock.calls[0][1]).not.toHaveProperty("categoria");
  });

  it.each([
    ["que no está en la lista", "CRYPTO"],
    ["que Meta no ofrece", "UNDEFINED"],
    ["que Meta no ofrece (2)", "NOT_A_BIZ"],
    ["en minúsculas", "finance"],
    ["con espacios", " FINANCE "],
    ["vacío", ""],
    ["que no es texto", 7],
    ["que es un objeto", { valor: "FINANCE" }],
    ["nulo", null],
  ])("un rubro %s se descarta y el alta sigue con el inicial", async (_caso, categoria) => {
    const r = await iniciarWabaPropia({ nombre: "Seguros Sur", categoria });

    expect(r.resultado).toBe("listo");
    expect(h.iniciar.mock.calls[0][1]).toEqual({ nombre: "Seguros Sur" });
  });

  it("deja la cookie del sello cerrada: sólo HTTP, segura, del mismo sitio, diez minutos", async () => {
    await iniciar();

    expect(h.galletaPuesta).toHaveBeenCalledTimes(1);
    const [nombre, valor, opciones] = h.galletaPuesta.mock.calls[0];
    expect(nombre).toBe("cm_waba");
    expect(valor).toMatch(/^[0-9a-f]{64}$/);
    expect(opciones).toEqual({ httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 600 });
  });

  it("el sello es de esta persona, vence en diez minutos y lleva el número al azar de la cookie sin mostrarlo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T12:00:00.000Z"));

    const inicio = await iniciar();

    const nonce = h.galletas.get("cm_waba")!;
    expect(abrir("waba-propia", inicio)).toEqual({ t: TENANT, u: USUARIO, n: nonce, exp: Date.now() + DIEZ_MINUTOS });
    expect(inicio).not.toContain(nonce);
    expect(abrir("otro-uso", inicio)).toBeNull();
  });

  it("cada apertura estrena sello y número al azar", async () => {
    const a = await iniciar();
    const nonceA = h.galletas.get("cm_waba");
    const b = await iniciar();

    expect(a).not.toBe(b);
    expect(h.galletas.get("cm_waba")).not.toBe(nonceA);
  });

  it.each([
    ["sin nombre", {}],
    ["nombre vacío", { nombre: "   " }],
    ["nombre que no es texto", { nombre: 42 }],
    ["nombre de más de 60 letras", { nombre: "x".repeat(61) }],
  ])("%s: «meta» y no toca el flujo ni deja cookie", async (_caso, entrada) => {
    expect(await iniciarWabaPropia(entrada)).toEqual({ resultado: "meta" });

    expect(h.iniciar).not.toHaveBeenCalled();
    expect(h.galletaPuesta).not.toHaveBeenCalled();
  });

  it.each([
    ["http plano", "http://seguros.example.com"],
    ["javascript:", "javascript:alert(1)"],
    ["no es una URL", "seguros punto com"],
    ["de más de 200 letras", `https://seguros.example.com/${"x".repeat(200)}`],
    ["no es texto", { href: "https://seguros.example.com" }],
  ])("sitio web %s: «meta»", async (_caso, web) => {
    expect(await iniciarWabaPropia({ nombre: "Seguros Sur", web })).toEqual({ resultado: "meta" });

    expect(h.iniciar).not.toHaveBeenCalled();
  });

  it("el tope por IP corta antes de todo: «esperar»", async () => {
    h.topePorIp.mockResolvedValue({ allowed: false });

    expect(await iniciarWabaPropia({ nombre: "Seguros Sur" })).toEqual({ resultado: "esperar" });

    expect(h.iniciar).not.toHaveBeenCalled();
    expect(h.galletaPuesta).not.toHaveBeenCalled();
  });

  it("sin IP el tope cuenta como «sin-ip»", async () => {
    h.cabeceras.mockReturnValue(new Headers());

    await iniciarWabaPropia({ nombre: "Seguros Sur" });

    expect(h.topePorIp).toHaveBeenCalledWith("sin-ip");
  });

  it("sin la app de Meta cargada (APP_ID o CONFIG_ID): «apagado»", async () => {
    h.appDeMeta.mockReturnValue(null);

    expect(await iniciarWabaPropia({ nombre: "Seguros Sur" })).toEqual({ resultado: "apagado" });

    expect(h.iniciar).not.toHaveBeenCalled();
  });

  it.each(["cupo", "conectado", "revision", "esperar", "apagado"] as const)("si el flujo contesta «%s» pasa tal cual, sin sello ni cookie", async (resultado) => {
    h.iniciar.mockResolvedValue({ resultado });

    expect(await iniciarWabaPropia({ nombre: "Seguros Sur" })).toEqual({ resultado });

    expect(h.galletaPuesta).not.toHaveBeenCalled();
  });
});

describe("conectarWabaPropia", () => {
  const PEDIDO = { code: "fake-popup-code", evento: "FINISH", wabaId: "200000000000001", phoneNumberId: "100000000000777" };
  const QUIEN = { tenantId: TENANT, userId: USUARIO, ip: IP, idioma: "es-AR" };

  it("con el sello bueno y la cookie, pasa el código y las pistas al flujo y devuelve lo que éste diga", async () => {
    const inicio = await iniciar();
    h.vincular.mockResolvedValue({ resultado: "numero_distinto", numeroMeta: "+5491100000000" });

    expect(await conectarWabaPropia({ inicio, ...PEDIDO })).toEqual({ resultado: "numero_distinto", numeroMeta: "+5491100000000" });

    expect(h.vincular).toHaveBeenCalledWith(QUIEN, PEDIDO);
  });

  it("el portfolio que diga el navegador no llega al flujo: lo saca el servidor del token", async () => {
    const inicio = await iniciar();

    const delNavegador = { inicio, ...PEDIDO, businessId: "400000000000001" };
    await conectarWabaPropia(delNavegador);

    expect(h.vincular).toHaveBeenCalledWith(QUIEN, PEDIDO);
  });

  it("el userID del popup pasa al flujo como pista del usuario de Facebook", async () => {
    const inicio = await iniciar();

    await conectarWabaPropia({ inicio, ...PEDIDO, userId: "1234567890" });

    expect(h.vincular).toHaveBeenCalledWith(QUIEN, { ...PEDIDO, userId: "1234567890" });
  });

  it("el usuario de Facebook se acepta con el mismo ancho que la base guarda (1 a 30 dígitos), no con el de los ids de la WABA", async () => {
    const inicio = await iniciar();

    await conectarWabaPropia({ inicio, ...PEDIDO, userId: "12345" });

    expect(h.vincular).toHaveBeenCalledWith(QUIEN, { ...PEDIDO, userId: "12345" });
  });

  it("las pistas son opcionales: sin ellas el flujo recibe sólo el código", async () => {
    const inicio = await iniciar();

    await conectarWabaPropia({ inicio, code: "fake-popup-code" });

    expect(h.vincular).toHaveBeenCalledWith(QUIEN, { code: "fake-popup-code" });
    expect(h.vincular.mock.calls[0][1]).toEqual({ code: "fake-popup-code", evento: undefined, wabaId: undefined, phoneNumberId: undefined });
  });

  it("gasta la cookie en el primer uso: un segundo pedido con el mismo sello es «vencido»", async () => {
    const inicio = await iniciar();

    await conectarWabaPropia({ inicio, ...PEDIDO });
    expect(await conectarWabaPropia({ inicio, ...PEDIDO })).toEqual({ resultado: "vencido" });

    expect(h.vincular).toHaveBeenCalledTimes(1);
    expect(h.galletaBorrada).toHaveBeenCalledTimes(2);
    expect(h.galletaBorrada).toHaveBeenCalledWith({ name: "cm_waba", path: "/" });
  });

  it("la cookie se gasta aunque el sello no valga", async () => {
    await iniciar();

    expect(await conectarWabaPropia({ inicio: "no-es-un-sello", ...PEDIDO })).toEqual({ resultado: "vencido" });

    expect(h.galletaBorrada).toHaveBeenCalledWith({ name: "cm_waba", path: "/" });
    expect(h.galletas.has("cm_waba")).toBe(false);
    expect(h.vincular).not.toHaveBeenCalled();
  });

  it("sin cookie (otro navegador, o ya gastada) el sello solo no alcanza", async () => {
    const inicio = await iniciar();
    h.galletas.clear();

    expect(await conectarWabaPropia({ inicio, ...PEDIDO })).toEqual({ resultado: "vencido" });

    expect(h.vincular).not.toHaveBeenCalled();
  });

  it("una cookie con otro número al azar no abre el sello", async () => {
    const inicio = await iniciar();
    h.galletas.set("cm_waba", "f".repeat(64));

    expect(await conectarWabaPropia({ inicio, ...PEDIDO })).toEqual({ resultado: "vencido" });

    expect(h.vincular).not.toHaveBeenCalled();
  });

  it("el sello de otra persona del mismo espacio no vale", async () => {
    const inicio = await iniciar();
    h.requireRole.mockResolvedValue(fila({ id: OTRO_USUARIO }));

    expect(await conectarWabaPropia({ inicio, ...PEDIDO })).toEqual({ resultado: "vencido" });

    expect(h.vincular).not.toHaveBeenCalled();
  });

  it("el sello de otro espacio no vale", async () => {
    const inicio = await iniciar();
    h.requireRole.mockResolvedValue(fila({ tenant_id: "44444444-4444-4444-8444-444444444444" }));

    expect(await conectarWabaPropia({ inicio, ...PEDIDO })).toEqual({ resultado: "vencido" });

    expect(h.vincular).not.toHaveBeenCalled();
  });

  it("pasados los diez minutos el sello vence, y justo antes todavía vale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T12:00:00.000Z"));
    const antes = await iniciar();
    vi.setSystemTime(Date.now() + DIEZ_MINUTOS - 1);
    await conectarWabaPropia({ inicio: antes, ...PEDIDO });
    expect(h.vincular).toHaveBeenCalledTimes(1);

    const despues = await iniciar();
    vi.setSystemTime(Date.now() + DIEZ_MINUTOS + 1);
    expect(await conectarWabaPropia({ inicio: despues, ...PEDIDO })).toEqual({ resultado: "vencido" });

    expect(h.vincular).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["sin sello", undefined],
    ["un sello que no es texto", 42],
    ["texto cualquiera", "v1.a.b.c"],
    ["un sello de otro uso", sellar("otro-uso", { t: TENANT, u: USUARIO, n: "x", exp: Date.now() + DIEZ_MINUTOS })],
  ])("%s: «vencido»", async (_caso, inicio) => {
    await iniciar();

    expect(await conectarWabaPropia({ inicio, ...PEDIDO })).toEqual({ resultado: "vencido" });

    expect(h.vincular).not.toHaveBeenCalled();
  });

  it("un sello armado con la forma bien pero sin vencimiento no vale", async () => {
    const nonce = "a".repeat(64);
    h.galletas.set("cm_waba", nonce);
    const inicio = sellar("waba-propia", { t: TENANT, u: USUARIO, n: nonce });

    expect(await conectarWabaPropia({ inicio, ...PEDIDO })).toEqual({ resultado: "vencido" });
  });

  it.each([
    ["sin código", { code: undefined }],
    ["código que no es texto", { code: 123456 }],
    ["código vacío", { code: "" }],
    ["código de más de 1024 letras", { code: "x".repeat(1025) }],
    ["evento en minúscula", { evento: "finish" }],
    ["evento con símbolos", { evento: "FINISH;DROP" }],
    ["evento de más de 60 letras", { evento: "A".repeat(61) }],
    ["evento que no es texto", { evento: { nombre: "FINISH" } }],
    ["WABA con letras", { wabaId: "abc123456" }],
    ["WABA de cinco dígitos", { wabaId: "12345" }],
    ["WABA de más de veinte dígitos", { wabaId: "1".repeat(21) }],
    ["WABA que es un número y no un texto", { wabaId: 200000000000001 }],
    ["número de teléfono con una ruta de Graph", { phoneNumberId: "../me/accounts" }],
    ["usuario de Facebook con letras", { userId: "abc123456" }],
    ["usuario de Facebook de más de treinta dígitos", { userId: "1".repeat(31) }],
    ["usuario de Facebook que es un número y no un texto", { userId: 1234567890 }],
  ])("%s: «meta», sin llegar al flujo", async (_caso, cambios) => {
    const inicio = await iniciar();

    expect(await conectarWabaPropia({ inicio, ...PEDIDO, ...cambios })).toEqual({ resultado: "meta" });

    expect(h.vincular).not.toHaveBeenCalled();
  });

  it("el tope por IP corta antes de mirar la cookie: «esperar», y la cookie sigue ahí para reintentar", async () => {
    const inicio = await iniciar();
    h.topePorIp.mockResolvedValue({ allowed: false });

    expect(await conectarWabaPropia({ inicio, ...PEDIDO })).toEqual({ resultado: "esperar" });

    expect(h.galletaBorrada).not.toHaveBeenCalled();
    expect(h.galletas.has("cm_waba")).toBe(true);
    expect(h.vincular).not.toHaveBeenCalled();
  });

  it("lo que tira el flujo vuelve «meta», sin el código en el registro", async () => {
    const inicio = await iniciar();
    h.vincular.mockRejectedValue(new TypeError("falló con fake-popup-code"));

    expect(await conectarWabaPropia({ inicio, ...PEDIDO })).toEqual({ resultado: "meta" });

    expect(JSON.stringify(h.error.mock.calls)).not.toContain("fake-popup-code");
  });

  it("sin entrada del todo no tira: «vencido»", async () => {
    expect(await conectarWabaPropia(undefined as never)).toEqual({ resultado: "vencido" });
  });
});

describe("aceptarNumeroDeMeta, reintentarWabaPropia y desconectarWabaPropia", () => {
  it("aceptar confirma el número con quien pide", async () => {
    h.aceptar.mockResolvedValue("revision");

    expect(await aceptarNumeroDeMeta()).toEqual({ resultado: "revision" });

    expect(h.aceptar).toHaveBeenCalledWith({ tenantId: TENANT, userId: USUARIO, ip: IP, idioma: "es-AR" });
  });

  it("reintentar retoma con quien pide, por la función que decide entre el nombre rechazado y el resto", async () => {
    h.reintentarApp.mockResolvedValue("falta_codigo");

    expect(await reintentarWabaPropia()).toEqual({ resultado: "falta_codigo" });

    expect(h.reintentarApp).toHaveBeenCalledWith({ tenantId: TENANT, userId: USUARIO, ip: IP, idioma: "es-AR" });
  });

  it("aceptar y reintentar también pasan por el tope por IP: sin lugar, «esperar» y Graph ni se toca", async () => {
    h.topePorIp.mockResolvedValue({ allowed: false });

    expect(await aceptarNumeroDeMeta()).toEqual({ resultado: "esperar" });
    expect(await reintentarWabaPropia()).toEqual({ resultado: "esperar" });

    expect(h.aceptar).not.toHaveBeenCalled();
    expect(h.reintentarApp).not.toHaveBeenCalled();
  });

  it("desconectar suelta con quien pide", async () => {
    expect(await desconectarWabaPropia()).toEqual({ resultado: "desconectado" });

    expect(h.desconectar).toHaveBeenCalledWith({ tenantId: TENANT, userId: USUARIO, ip: IP, idioma: "es-AR" });
  });

  it("cancelar la app que se está armando va con quien pide y devuelve lo que contestó el flujo", async () => {
    h.cancelarApp.mockResolvedValue("transicion");

    expect(await cancelarAppPropia()).toEqual({ resultado: "transicion" });

    expect(h.cancelarApp).toHaveBeenCalledWith({ tenantId: TENANT, userId: USUARIO, ip: IP, idioma: "es-AR" });
  });

  it("cancelar no se frena con el tope por IP: salir de una vía no puede quedar trabado", async () => {
    h.topePorIp.mockResolvedValue({ allowed: false });

    expect(await cancelarAppPropia()).toEqual({ resultado: "cancelado" });

    expect(h.cancelarApp).toHaveBeenCalledTimes(1);
  });
});

describe("codigoDeWabaPropia", () => {
  it.each(["SMS", "VOICE"] as const)("%s se pide al flujo sin código", async (accion) => {
    expect(await codigoDeWabaPropia({ accion })).toEqual({ resultado: "codigo_enviado" });

    expect(h.codigo).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }), { accion });
  });

  it("al verificar, los espacios del medio no cuentan («123 456»)", async () => {
    await codigoDeWabaPropia({ accion: "verificar", codigo: " 123 456 " });

    expect(h.codigo).toHaveBeenCalledWith(expect.anything(), { accion: "verificar", codigo: "123456" });
  });

  it.each([
    ["no es texto", 123456],
    ["de más de 32 letras", "1".repeat(33)],
    ["no viene", undefined],
  ])("un código que %s llega vacío y el flujo lo rechaza", async (_caso, codigo) => {
    await codigoDeWabaPropia({ accion: "verificar", codigo });

    expect(h.codigo).toHaveBeenCalledWith(expect.anything(), { accion: "verificar", codigo: "" });
  });

  it.each([["EMAIL"], [undefined], [42], ["sms"]])("la acción %j no existe: «meta», sin llegar al flujo", async (accion) => {
    expect(await codigoDeWabaPropia({ accion })).toEqual({ resultado: "meta" });

    expect(h.codigo).not.toHaveBeenCalled();
  });
});

describe("pinDeWabaPropia", () => {
  it("se recorta y se pasa al flujo", async () => {
    await pinDeWabaPropia({ pin: " 482915 " });

    expect(h.pin).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }), "482915");
  });

  it.each([
    ["no es texto", 482915],
    ["es de más de 32 letras", "1".repeat(33)],
    ["no viene", undefined],
  ])("un PIN que %s llega vacío y el flujo lo rechaza", async (_caso, pin) => {
    await pinDeWabaPropia({ pin });

    expect(h.pin).toHaveBeenCalledWith(expect.anything(), "");
  });

  it("el PIN no se anota ni vuelve en el resultado", async () => {
    h.pin.mockRejectedValue(new TypeError("falló con 482915"));

    const r = await pinDeWabaPropia({ pin: "482915" });

    expect(JSON.stringify(r)).not.toContain("482915");
    expect(JSON.stringify(h.error.mock.calls)).not.toContain("482915");
  });
});

describe("cancelacionDeWabaPropia", () => {
  it("pasa el paso tal cual al flujo (éste lo reduce a la lista) y el código sólo si es un número", async () => {
    await cancelacionDeWabaPropia({ paso: "permissions", codigo: 4 });
    await cancelacionDeWabaPropia({ paso: "permissions", codigo: "mensaje del navegador" });
    await cancelacionDeWabaPropia({ paso: { raro: true } });

    expect(h.cancelar.mock.calls.map(([, paso, codigo]) => [paso, codigo])).toEqual([
      ["permissions", 4],
      ["permissions", undefined],
      [{ raro: true }, undefined],
    ]);
  });

  it("devuelve lo que contesta el flujo", async () => {
    expect(await cancelacionDeWabaPropia({ paso: "permissions" })).toEqual({ resultado: "cancelado" });
  });

  it("sin entrada del todo tampoco tira", async () => {
    expect(await cancelacionDeWabaPropia(undefined as never)).toEqual({ resultado: "cancelado" });
  });
});

describe("iniciarAppPropia", () => {
  const ENTRADA = { acuerdo: "2026-10", razonSocial: "Seguros Sur SA", cuit: "30-71234567-1" };
  const CLAVE = claveDeCupo("wa:app:inicio", TENANT);

  it("pasa el acuerdo, la razón social y el CUIT al flujo con quien pide, y sin número no manda la clave", async () => {
    expect(await iniciarAppPropia(ENTRADA)).toEqual({ resultado: "listo" });

    expect(h.iniciarApp).toHaveBeenCalledWith(QUIEN, ENTRADA);
    expect(h.iniciarApp.mock.calls[0][1]).not.toHaveProperty("numero");
  });

  it("con el número que la persona quiere usar, lo pasa", async () => {
    await iniciarAppPropia({ ...ENTRADA, numero: "+54 9 11 1234-5678" });

    expect(h.iniciarApp).toHaveBeenCalledWith(QUIEN, { ...ENTRADA, numero: "+54 9 11 1234-5678" });
  });

  it.each([[undefined], [null], [""]])("un número %j no es un número: el flujo no recibe la clave", async (numero) => {
    await iniciarAppPropia({ ...ENTRADA, numero });

    expect(h.iniciarApp.mock.calls[0][1]).not.toHaveProperty("numero");
  });

  it("toma el cupo del día del espacio, tras el tope por IP", async () => {
    await iniciarAppPropia(ENTRADA);

    expect(h.topePorIp).toHaveBeenCalledWith(IP);
    expect(h.rateLimit).toHaveBeenCalledTimes(1);
    expect(h.rateLimit).toHaveBeenCalledWith(CLAVE, RATE_LIMIT_CONFIGS.APP_PROPIA_INICIO);
  });

  it("el cupo que sirvió a un arranque que prosperó no se devuelve", async () => {
    await iniciarAppPropia(ENTRADA);

    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it.each(["formato", "razon_invalida", "cuit_invalido", "numero_invalido", "apagado", "ya_conectado", "transicion", "meta", "cupo"] as const)(
    "si el flujo contesta «%s» devuelve el cupo: un arranque que no prospera no gasta uno de los tres del día",
    async (resultado) => {
      h.iniciarApp.mockResolvedValue({ resultado });

      expect(await iniciarAppPropia(ENTRADA)).toEqual({ resultado });

      expect(h.liberarCupo).toHaveBeenCalledWith(CLAVE, RATE_LIMIT_CONFIGS.APP_PROPIA_INICIO.windowMs, VENTANA);
    }
  );

  it("si devolver el cupo falla, el resultado llega igual", async () => {
    h.iniciarApp.mockResolvedValue({ resultado: "apagado" });
    h.liberarCupo.mockRejectedValue(new Error("contador caído"));

    expect(await iniciarAppPropia(ENTRADA)).toEqual({ resultado: "apagado" });
  });

  it("si el flujo tira, vuelve «meta», se devuelve el cupo y sólo se anota el nombre del error", async () => {
    h.iniciarApp.mockRejectedValue(new RangeError("detalle con 30-71234567-1"));

    expect(await iniciarAppPropia(ENTRADA)).toEqual({ resultado: "meta" });

    expect(h.error).toHaveBeenCalledWith({ error: "RangeError" }, "conectar_whatsapp.waba_accion_fallo");
    expect(JSON.stringify(h.error.mock.calls)).not.toContain("30-71234567-1");
  });

  it("sin cupo del día contesta «esperar», lo devuelve y no toca el flujo", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, ventana: VENTANA });

    expect(await iniciarAppPropia(ENTRADA)).toEqual({ resultado: "esperar" });

    expect(h.liberarCupo).toHaveBeenCalledWith(CLAVE, RATE_LIMIT_CONFIGS.APP_PROPIA_INICIO.windowMs, VENTANA);
    expect(h.iniciarApp).not.toHaveBeenCalled();
  });

  it("sin lugar por IP contesta «esperar» antes de gastar el cupo", async () => {
    h.topePorIp.mockResolvedValue({ allowed: false });

    expect(await iniciarAppPropia(ENTRADA)).toEqual({ resultado: "esperar" });

    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.iniciarApp).not.toHaveBeenCalled();
  });

  it.each([
    ["el acuerdo no es texto", { acuerdo: 2026 }, "formato"],
    ["el acuerdo es de más de 20 letras", { acuerdo: "x".repeat(21) }, "formato"],
    ["falta el acuerdo", { acuerdo: undefined }, "formato"],
    ["la razón social no es texto", { razonSocial: { nombre: "x" } }, "razon_invalida"],
    ["la razón social es de más de 120 letras", { razonSocial: "x".repeat(121) }, "razon_invalida"],
    ["falta la razón social", { razonSocial: undefined }, "razon_invalida"],
    ["el CUIT no es texto", { cuit: 30712345671 }, "cuit_invalido"],
    ["el CUIT es de más de 13 letras", { cuit: "3".repeat(14) }, "cuit_invalido"],
    ["falta el CUIT", { cuit: undefined }, "cuit_invalido"],
    ["el número no es texto", { numero: 5491112345678 }, "numero_invalido"],
    ["el número es de más de 20 letras", { numero: "1".repeat(21) }, "numero_invalido"],
  ])("%s: sin gastar cupo ni tocar el flujo", async (_caso, cambios, esperado) => {
    expect(await iniciarAppPropia({ ...ENTRADA, ...cambios })).toEqual({ resultado: esperado });

    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.liberarCupo).not.toHaveBeenCalled();
    expect(h.iniciarApp).not.toHaveBeenCalled();
  });

  it("sin entrada del todo no tira: «formato»", async () => {
    expect(await iniciarAppPropia(undefined as never)).toEqual({ resultado: "formato" });
  });

  it("un campo vacío llega al flujo, que es quien lo rechaza", async () => {
    h.iniciarApp.mockResolvedValue({ resultado: "razon_invalida" });

    expect(await iniciarAppPropia({ ...ENTRADA, razonSocial: "" })).toEqual({ resultado: "razon_invalida" });

    expect(h.iniciarApp).toHaveBeenCalledWith(QUIEN, { ...ENTRADA, razonSocial: "" });
  });

  it("quién pide no sale del cuerpo", async () => {
    await iniciarAppPropia({ ...ENTRADA, tenantId: "otro", userId: "otro" } as never);

    expect(h.iniciarApp).toHaveBeenCalledWith(QUIEN, ENTRADA);
    expect(h.rateLimit).toHaveBeenCalledWith(CLAVE, expect.anything());
  });
});

describe("credencialesDeAppPropia", () => {
  const ENTRADA = { appId: "100000000000555", secreto: "fake-app-secret-value" };

  it("pasa el ID y el secreto al flujo y devuelve sólo el resultado", async () => {
    h.credencialesApp.mockResolvedValue({ resultado: "listo", secreto: "no-debe-salir" });

    const r = await credencialesDeAppPropia(ENTRADA);

    expect(h.credencialesApp).toHaveBeenCalledWith(QUIEN, ENTRADA);
    expect(h.rateLimit).toHaveBeenCalledWith(claveDeCupo("wa:app", TENANT), RATE_LIMIT_CONFIGS.APP_PROPIA);
    expect(r.resultado).toBe("listo");
  });

  it.each([
    ["el ID no es texto", { appId: 100000000000555 }, "formato_app"],
    ["el ID es de más de 20 letras", { appId: "1".repeat(21) }, "formato_app"],
    ["falta el ID", { appId: undefined }, "formato_app"],
    ["el secreto no es texto", { secreto: 12345 }, "formato_secreto"],
    ["el secreto es de más de 128 letras", { secreto: "a".repeat(129) }, "formato_secreto"],
    ["falta el secreto", { secreto: undefined }, "formato_secreto"],
  ])("%s: sin gastar cupo ni tocar el flujo", async (_caso, cambios, esperado) => {
    expect(await credencialesDeAppPropia({ ...ENTRADA, ...cambios })).toEqual({ resultado: esperado });

    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.credencialesApp).not.toHaveBeenCalled();
  });

  it("sin entrada del todo no tira: «formato_app»", async () => {
    expect(await credencialesDeAppPropia(undefined as never)).toEqual({ resultado: "formato_app" });
  });

  it("sin cupo de la hora contesta «esperar» y no toca el flujo", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, ventana: VENTANA });

    expect(await credencialesDeAppPropia(ENTRADA)).toEqual({ resultado: "esperar" });

    expect(h.credencialesApp).not.toHaveBeenCalled();
  });

  it("el secreto no se anota ni vuelve cuando el flujo tira", async () => {
    h.credencialesApp.mockRejectedValue(new TypeError("falló con fake-app-secret-value"));

    const r = await credencialesDeAppPropia(ENTRADA);

    expect(r).toEqual({ resultado: "meta" });
    expect(JSON.stringify(r)).not.toContain("fake-app-secret-value");
    expect(JSON.stringify(h.error.mock.calls)).not.toContain("fake-app-secret-value");
  });
});

describe("webhookDeAppPropia", () => {
  it("devuelve la dirección y la marca que el cliente pega en su app, con el cupo de la hora", async () => {
    expect(await webhookDeAppPropia()).toEqual({ resultado: "listo", webhook: WEBHOOK });

    expect(h.webhookApp).toHaveBeenCalledWith(QUIEN);
    expect(h.rateLimit).toHaveBeenCalledWith(claveDeCupo("wa:app", TENANT), RATE_LIMIT_CONFIGS.APP_PROPIA);
  });

  it.each(["ajeno", "revisar"] as const)("el aviso «%s» llega tal cual", async (aviso) => {
    h.webhookApp.mockResolvedValue({ resultado: "listo", webhook: { ...WEBHOOK, aviso } });

    expect(await webhookDeAppPropia()).toEqual({ resultado: "listo", webhook: { ...WEBHOOK, aviso } });
  });

  it("sin cupo contesta «esperar» y no toca el flujo", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, ventana: VENTANA });

    expect(await webhookDeAppPropia()).toEqual({ resultado: "esperar" });

    expect(h.webhookApp).not.toHaveBeenCalled();
  });
});

describe("tokenDeAppPropia", () => {
  const ENTRADA = { token: "fake-system-user-token", wabaId: "200000000000001" };

  it("pasa el token y la WABA al flujo, sin la pista del número si no vino", async () => {
    expect(await tokenDeAppPropia(ENTRADA)).toEqual({ resultado: "conectado" });

    expect(h.tokenApp).toHaveBeenCalledWith(QUIEN, ENTRADA);
    expect(h.tokenApp.mock.calls[0][1]).not.toHaveProperty("phoneNumberId");
    expect(h.rateLimit).toHaveBeenCalledWith(claveDeCupo("wa:app", TENANT), RATE_LIMIT_CONFIGS.APP_PROPIA);
  });

  it("pasa el rubro que eligió el cliente, y descarta uno que no es de la lista de Meta", async () => {
    await tokenDeAppPropia({ ...ENTRADA, categoria: "HEALTH" });
    expect(h.tokenApp).toHaveBeenLastCalledWith(QUIEN, { ...ENTRADA, categoria: "HEALTH" });

    await tokenDeAppPropia({ ...ENTRADA, categoria: "health" });
    expect(h.tokenApp.mock.calls.at(-1)?.[1]).not.toHaveProperty("categoria");
    await tokenDeAppPropia({ ...ENTRADA, categoria: 7 });
    expect(h.tokenApp.mock.calls.at(-1)?.[1]).not.toHaveProperty("categoria");
  });

  it("con el número elegido entre varios, lo pasa", async () => {
    await tokenDeAppPropia({ ...ENTRADA, phoneNumberId: "100000000000777" });

    expect(h.tokenApp).toHaveBeenCalledWith(QUIEN, { ...ENTRADA, phoneNumberId: "100000000000777" });
  });

  it("devuelve lo que contesta el flujo: los números a elegir, el número de Meta, el permiso", async () => {
    const numeros = [{ id: "100000000000777", display: "+54 9 11 1234-5678" }];
    h.tokenApp.mockResolvedValue({ resultado: "elegir_numero", numeros });
    expect(await tokenDeAppPropia(ENTRADA)).toEqual({ resultado: "elegir_numero", numeros });

    h.tokenApp.mockResolvedValue({ resultado: "numero_distinto", numeroMeta: "+5491100000000" });
    expect(await tokenDeAppPropia(ENTRADA)).toEqual({ resultado: "numero_distinto", numeroMeta: "+5491100000000" });

    h.tokenApp.mockResolvedValue({ resultado: "falta_permiso", permiso: "whatsapp_business_messaging" });
    expect(await tokenDeAppPropia(ENTRADA)).toEqual({ resultado: "falta_permiso", permiso: "whatsapp_business_messaging" });
  });

  it.each([
    ["el token no es texto", { token: 12345 }, "token_formato"],
    ["el token es de más de 2048 letras", { token: "t".repeat(2049) }, "token_formato"],
    ["falta el token", { token: undefined }, "token_formato"],
    ["la WABA no es texto", { wabaId: 200000000000001 }, "waba_formato"],
    ["la WABA es de más de 20 letras", { wabaId: "2".repeat(21) }, "waba_formato"],
    ["falta la WABA", { wabaId: undefined }, "waba_formato"],
    ["el número es de más de 20 letras", { phoneNumberId: "1".repeat(21) }, "meta"],
    ["el número no es texto", { phoneNumberId: 100000000000777 }, "meta"],
  ])("%s: sin gastar cupo ni tocar el flujo", async (_caso, cambios, esperado) => {
    expect(await tokenDeAppPropia({ ...ENTRADA, ...cambios })).toEqual({ resultado: esperado });

    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.tokenApp).not.toHaveBeenCalled();
  });

  it("un WABA ID vacío llega al flujo: en el cambio de token (E6) no se usa y el flujo decide", async () => {
    await tokenDeAppPropia({ token: ENTRADA.token, wabaId: "" });

    expect(h.tokenApp).toHaveBeenCalledWith(QUIEN, { token: ENTRADA.token, wabaId: "" });
  });

  it("sin cupo contesta «esperar» y no toca el flujo", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, ventana: VENTANA });

    expect(await tokenDeAppPropia(ENTRADA)).toEqual({ resultado: "esperar" });

    expect(h.tokenApp).not.toHaveBeenCalled();
  });

  it("el token no se anota ni vuelve cuando el flujo tira", async () => {
    h.tokenApp.mockRejectedValue(new TypeError("falló con fake-system-user-token"));

    const r = await tokenDeAppPropia(ENTRADA);

    expect(r).toEqual({ resultado: "meta" });
    expect(JSON.stringify(h.error.mock.calls)).not.toContain("fake-system-user-token");
  });

  it("sin entrada del todo no tira: «token_formato»", async () => {
    expect(await tokenDeAppPropia(undefined as never)).toEqual({ resultado: "token_formato" });
  });
});

describe("nombreDeAppPropia", () => {
  it("pasa el nombre al flujo con el cupo de la hora", async () => {
    expect(await nombreDeAppPropia({ nombre: "Seguros Sur" })).toEqual({ resultado: "listo" });

    expect(h.nombreApp).toHaveBeenCalledWith(QUIEN, "Seguros Sur");
    expect(h.rateLimit).toHaveBeenCalledWith(claveDeCupo("wa:app", TENANT), RATE_LIMIT_CONFIGS.APP_PROPIA);
  });

  it.each([
    ["no es texto", 42],
    ["es de más de 60 letras", "x".repeat(61)],
    ["no viene", undefined],
  ])("un nombre que %s: «nombre_invalido» sin gastar cupo ni tocar el flujo", async (_caso, nombre) => {
    expect(await nombreDeAppPropia({ nombre })).toEqual({ resultado: "nombre_invalido" });

    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.nombreApp).not.toHaveBeenCalled();
  });

  it("sin cupo contesta «esperar» y no toca el flujo", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, ventana: VENTANA });

    expect(await nombreDeAppPropia({ nombre: "Seguros Sur" })).toEqual({ resultado: "esperar" });

    expect(h.nombreApp).not.toHaveBeenCalled();
  });

  it("sin entrada del todo no tira: «nombre_invalido»", async () => {
    expect(await nombreDeAppPropia(undefined as never)).toEqual({ resultado: "nombre_invalido" });
  });
});

describe("estadoDeAppPropia", () => {
  it("devuelve el estado tal cual, con su propio tope y sin pasar por el de las acciones", async () => {
    expect(await estadoDeAppPropia()).toEqual(ESTADO);

    expect(h.estadoApp).toHaveBeenCalledWith(QUIEN);
    expect(h.rateLimit).toHaveBeenCalledTimes(1);
    expect(h.rateLimit).toHaveBeenCalledWith(claveDeCupo("wa:app:estado", TENANT), RATE_LIMIT_CONFIGS.ESTADO_APP);
    expect(h.topePorIp).not.toHaveBeenCalled();
  });

  it("pasado el tope contesta «esperar», que se distingue de un estado porque no trae «paso»", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, ventana: VENTANA });

    const r = await estadoDeAppPropia();

    expect(r).toEqual({ resultado: "esperar" });
    expect(r).not.toHaveProperty("paso");
    expect(h.estadoApp).not.toHaveBeenCalled();
  });

  it("no gasta el cupo de las acciones que llaman a Graph", async () => {
    await estadoDeAppPropia();

    expect(h.rateLimit).not.toHaveBeenCalledWith(claveDeCupo("wa:app", TENANT), expect.anything());
  });

  it("si leer el estado tira, vuelve «meta»", async () => {
    h.estadoApp.mockRejectedValue(new TypeError("base caída"));

    expect(await estadoDeAppPropia()).toEqual({ resultado: "meta" });
  });
});
