/**
 * /conectar-whatsapp/app (la página de servidor): a quién le abre el asistente de «app propia»,
 * a quién lo manda a otro lado, y con qué arma el panel. Lo importante: una sola lectura de la
 * base y ningún secreto en lo que baja al navegador.
 *
 * El panel es un doble que muestra lo que recibió. `appPropia`, `pasoDelAsistente`,
 * `estadoPublico`, `legalesDeApp`, `webhookDeLaFila` y `enlaceDeAyuda` son los de verdad.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sesion: vi.fn(),
  fila: vi.fn(),
  leer: vi.fn(),
  almacen: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }) }));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: h.sesion }));
vi.mock("@/lib/auth/fila-de-usuario-cacheada", () => ({ filaDeUsuario: h.fila }));
vi.mock("@/lib/i18n/locale", () => ({
  resolveAccountLocale: async (l?: string | null) => (l === "en-US" ? "en-US" : "es-AR"),
}));
vi.mock("@/app/login/actions", () => ({ signOut: vi.fn() }));
vi.mock("@/server/alta/waba-propia", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/alta/waba-propia")>()),
  almacenDelInquilino: h.almacen,
}));
vi.mock("@/app/conectar-whatsapp/app/AppPropiaPanel", () => ({
  AppPropiaPanel: (props: Record<string, unknown>) => <pre data-testid="panel">{JSON.stringify(props)}</pre>,
}));

import ConectarWhatsappAppPage, { maxDuration } from "@/app/conectar-whatsapp/app/page";
import type { FilaDeWaba } from "@/server/alta/waba-propia";
import { VERSION_DEL_ANEXO } from "@/server/alta/waba-resultados";

const SITIO = "https://claimmix.example.com";
const APP_ID = "500000000000001";
const SECRETO = "fake-client-app-secret";
const TOKEN = "fake-system-user-token";
const PIN = "654321";
const RUTA = "fake-ruta-0123456789abc";
const SLUG = "abcdefghij012345";
const CUIT = "30712345671";
const NUMERO = "+5491112345678";
const AHORA = new Date("2026-10-13T12:00:00Z");

const ENTORNO: Record<string, string> = {
  ALTA_APP_PROPIA: "1",
  NEXT_PUBLIC_SITE_URL: SITIO,
  META_APP_ID: "100000000000009",
  META_ES_CONFIG_ID: "fake-config-id",
  WHATSAPP_APP_SECRET: "fake-platform-app-secret",
  WHATSAPP_APP_SECRETS_KEY: "test-app-secrets-key",
  BETTER_AUTH_SECRET: "test-better-auth-secret-key",
  GMAIL_TOKEN_ENCRYPTION_KEY: "test-waba-encryption-key",
  ADMIN_EMAILS: "operador@example.com",
};
const NOMBRES = [...Object.keys(ENTORNO), "ALTA_WABA_PROPIA"];
const sinEntorno = () => NOMBRES.forEach((nombre) => delete process.env[nombre]);
const conEntorno = () => Object.entries(ENTORNO).forEach(([nombre, valor]) => (process.env[nombre] = valor));

const fila = (extra: Record<string, unknown> = {}) => ({
  id: "u-1",
  tenant_id: "t-1",
  role: "owner",
  locale: "es-AR",
  autoalta: true,
  ...extra,
});

/** La fila de una alta de la app propia que recién empieza (P1). */
const lectura = (extra: Partial<FilaDeWaba> = {}): FilaDeWaba => ({
  estado: "armando",
  falla: null,
  wabaId: null,
  businessId: null,
  phoneNumberId: null,
  numeroTipeado: NUMERO,
  numeroMeta: null,
  numeroAceptado: false,
  token: null,
  pin: null,
  nombreEstado: null,
  plantillaEnviadaEn: null,
  numeroEstado: null,
  emailDeContacto: "dueno@example.com",
  nombreDelEspacio: "Aseguradora Sur",
  origen: "app_propia",
  appId: null,
  secreto: null,
  ruta: RUTA,
  webhookAppVerificadoEn: null,
  datosAppEn: null,
  primerMensajeEn: null,
  primeraRespuestaEn: null,
  slugLegal: SLUG,
  razonSocial: "Aseguradora Sur S.A.",
  cuit: CUIT,
  acuerdoVersion: VERSION_DEL_ANEXO,
  recordatorioEn: null,
  puedeEnviar: null,
  ...extra,
});

const conApp = (extra: Partial<FilaDeWaba> = {}) => lectura({ appId: APP_ID, secreto: SECRETO, ...extra });
const conectada = (extra: Partial<FilaDeWaba> = {}) =>
  conApp({
    estado: "conectada",
    wabaId: "200000000000001",
    phoneNumberId: "100000000000777",
    numeroEstado: "conectado",
    numeroMeta: NUMERO,
    token: TOKEN,
    pin: PIN,
    webhookAppVerificadoEn: AHORA,
    ...extra,
  });

async function pintar() {
  return render(await ConectarWhatsappAppPage());
}
const props = () => JSON.parse(screen.getByTestId("panel").textContent ?? "{}");
const redirige = async () => {
  try {
    await ConectarWhatsappAppPage();
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

beforeEach(() => {
  vi.clearAllMocks();
  sinEntorno();
  conEntorno();
  h.sesion.mockResolvedValue({ user: { id: "u-1", email: "ana@example.com" } });
  h.fila.mockResolvedValue(fila());
  h.almacen.mockReturnValue({ leer: h.leer });
  h.leer.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sinEntorno();
});

describe("a quién le abre el asistente", () => {
  it("sin sesión va al login, sin tocar la base", async () => {
    h.sesion.mockResolvedValue(null);

    expect(await redirige()).toBe("REDIRECT:/login");
    expect(h.leer).not.toHaveBeenCalled();
  });

  it("sin fila de usuario va a «pendiente»", async () => {
    h.fila.mockResolvedValue(undefined);

    expect(await redirige()).toBe("REDIRECT:/pendiente");
  });

  it.each(["owner", "admin"])("el rol %s lo ve", async (role) => {
    h.fila.mockResolvedValue(fila({ role }));

    await pintar();

    expect(screen.getByRole("heading", { name: "Conectá tu WhatsApp con tu propia app de Meta" })).toBeInTheDocument();
    expect(screen.getByTestId("panel")).toBeInTheDocument();
  });

  it.each(["analyst", "specialist", "viewer"])("el rol %s vuelve a /configuracion#whatsapp", async (role) => {
    h.fila.mockResolvedValue(fila({ role }));

    expect(await redirige()).toBe("REDIRECT:/configuracion#whatsapp");
    expect(h.leer).not.toHaveBeenCalled();
  });

  it.each([false, null, undefined])("un espacio que no es del alta automática (autoalta %j) vuelve a /configuracion#whatsapp", async (autoalta) => {
    h.fila.mockResolvedValue(fila({ autoalta }));

    expect(await redirige()).toBe("REDIRECT:/configuracion#whatsapp");
  });

  it.each(["ALTA_APP_PROPIA", "NEXT_PUBLIC_SITE_URL", "META_APP_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_APP_SECRETS_KEY"])(
    "sin %s y sin nada empezado, la ruta no existe para nadie",
    async (falta) => {
      delete process.env[falta];

      expect(await redirige()).toBe("REDIRECT:/configuracion#whatsapp");
    }
  );

  it("sin nada empezado y con la vía prendida arranca en P0", async () => {
    await pintar();

    expect(props()).toMatchObject({ paso: "P0", estado: { paso: "P0", estado: null }, numeroTipeado: null, empresa: "" });
  });

  it("una alta cancelada o revocada empieza de cero si la vía está prendida, y vuelve si no", async () => {
    for (const estado of ["cancelada", "revocada"]) {
      h.leer.mockResolvedValue(conApp({ estado }));
      await pintar();
      expect(props().paso).toBe("P0");
      cleanup();

      delete process.env.ALTA_APP_PROPIA;
      expect(await redirige()).toBe("REDIRECT:/configuracion#whatsapp");
      process.env.ALTA_APP_PROPIA = "1";
    }
  });

  it("una cancelada con el número todavía conectado vuelve a /configuracion#whatsapp", async () => {
    h.leer.mockResolvedValue(conectada({ estado: "cancelada" }));

    expect(await redirige()).toBe("REDIRECT:/configuracion#whatsapp");
  });

  it("una alta de la app propia en curso se ve aunque la vía esté apagada: la persona ve lo que ya tiene", async () => {
    delete process.env.ALTA_APP_PROPIA;
    h.leer.mockResolvedValue(conApp());

    await pintar();

    expect(props().paso).toBe("P1B");
  });

  describe("el popup de Meta se abre en /conectar-whatsapp, con otra CSP que esta ruta", () => {
    // Un redirect() de servidor llegado por router.refresh() es una navegación del cliente y conserva la
    // CSP de este documento, sin los orígenes de Facebook: la vuelta tiene que ser una carga completa.
    it.each([
      ["quien ya conectó por el popup de Meta", () => lectura({ origen: "embedded_signup", estado: "conectada", numeroEstado: "conectado" })],
      ["una alta del camino viejo, sin origen y viva", () => lectura({ origen: null, estado: "armando" })],
    ])("%s: no redirige del lado del cliente, lleva a /conectar-whatsapp con una carga completa", async (_caso, fila) => {
      h.leer.mockResolvedValue(fila());
      const reemplazar = vi.fn();
      vi.stubGlobal("location", { replace: reemplazar });

      await pintar();

      expect(screen.queryByTestId("panel")).not.toBeInTheDocument();
      const enlace = screen.getByRole("link", { name: "Continuar" });
      expect(enlace).toHaveAttribute("href", "/conectar-whatsapp");
      expect(enlace).not.toHaveAttribute("data-next-link");
      expect(reemplazar).toHaveBeenCalledWith("/conectar-whatsapp");
    });

    it("el enlace sale en el idioma de la cuenta", async () => {
      h.fila.mockResolvedValue(fila({ locale: "en-US" }));
      h.leer.mockResolvedValue(lectura({ origen: "embedded_signup", estado: "conectada", numeroEstado: "conectado" }));
      vi.stubGlobal("location", { replace: vi.fn() });

      await pintar();

      expect(screen.getByRole("link", { name: "Continue" })).toHaveAttribute("href", "/conectar-whatsapp");
    });
  });
});

describe("lo que recibe el panel", () => {
  it("lee una sola vez, con el espacio, la persona, la IP y el idioma", async () => {
    h.leer.mockResolvedValue(conApp({ webhookAppVerificadoEn: AHORA }));

    await pintar();

    expect(h.leer).toHaveBeenCalledOnce();
    expect(h.almacen).toHaveBeenCalledOnce();
    expect(h.almacen).toHaveBeenCalledWith({ tenantId: "t-1", userId: "u-1", ip: "203.0.113.7", idioma: "es-AR" });
  });

  it("el nombre del espacio, el número tipeado, el idioma y el paso", async () => {
    h.leer.mockResolvedValue(conApp({ webhookAppVerificadoEn: AHORA }));

    await pintar();

    expect(props()).toMatchObject({
      paso: "P2",
      empresa: "Aseguradora Sur",
      numeroTipeado: NUMERO,
      locale: "es-AR",
      estado: { paso: "P2", appId: APP_ID, webhookVerificado: true },
    });
  });

  it("en inglés, con el título y el asunto del correo de ayuda en inglés", async () => {
    h.fila.mockResolvedValue(fila({ locale: "en-US" }));
    h.leer.mockResolvedValue(conApp({ webhookAppVerificadoEn: AHORA }));

    await pintar();

    expect(props().locale).toBe("en-US");
    expect(screen.getByRole("heading", { name: "Connect your WhatsApp with your own Meta app" })).toBeInTheDocument();
    expect(new URLSearchParams(String(props().ayuda).split("?")[1]).get("subject")).toBe("WhatsApp setup with own app: Aseguradora Sur");
  });

  it("el correo de ayuda lleva la dirección del operador, el asunto de la app y el nombre del espacio", async () => {
    h.leer.mockResolvedValue(conApp({ wabaId: "200000000000001" }));

    await pintar();

    const ayuda: string = props().ayuda;
    expect(ayuda.startsWith("mailto:operador@example.com?")).toBe(true);
    const consulta = new URLSearchParams(ayuda.split("?")[1]);
    expect(consulta.get("subject")).toContain("Aseguradora Sur");
    expect(consulta.get("body")).toContain("t-1");
    expect(consulta.get("body")).toContain("200000000000001");
  });

  it("sin dirección de operador cargada no hay enlace de ayuda", async () => {
    delete process.env.ADMIN_EMAILS;

    await pintar();

    expect(props().ayuda).toBeNull();
  });

  it("sin fila el espacio no tiene nombre ni WABA y el correo se arma igual", async () => {
    await pintar();

    const consulta = new URLSearchParams(String(props().ayuda).split("?")[1]);
    expect(consulta.get("body")).toContain("-");
  });
});

describe("los datos que sólo van a un paso", () => {
  it("los datos legales van sólo en P1B, con las tres direcciones, el contacto y si ya están listos", async () => {
    h.leer.mockResolvedValue(conApp());

    await pintar();

    expect(props().paso).toBe("P1B");
    expect(props().legales).toEqual({
      terminos: `${SITIO}/legal/${SLUG}/terminos`,
      privacidad: `${SITIO}/legal/${SLUG}/privacidad`,
      borrado: `${SITIO}/legal/${SLUG}/borrado`,
      contacto: "dueno@example.com",
      listos: false,
    });
  });

  it.each([
    ["P1", lectura()],
    ["E14", conApp({ estado: "suscripta" })],
    ["P2", conApp({ webhookAppVerificadoEn: AHORA })],
    ["P4", conectada()],
    ["G", conectada({ primeraRespuestaEn: AHORA })],
  ] as const)("en %s no van los datos legales", async (paso, entrada) => {
    h.leer.mockResolvedValue(entrada);

    await pintar();

    expect(props().paso).toBe(paso);
    expect(props().legales).toBeUndefined();
  });

  it.each([
    ["P1B", conApp()],
    ["E14", conApp({ estado: "suscripta" })],
    // Verificado y con el callback cambiado después: «Seguir» devuelve webhook_pendiente y el panel abre E14 con estos datos.
    ["seguir", conApp({ estado: "suscripta", webhookAppVerificadoEn: AHORA })],
  ] as const)("en %s va la dirección y la marca del webhook", async (paso, entrada) => {
    h.leer.mockResolvedValue(entrada);

    await pintar();

    expect(props().paso).toBe(paso);
    expect(props().webhook.url).toBe(`${SITIO}/api/webhooks/whatsapp/app/${RUTA}`);
    expect(props().webhook.verifyToken).toEqual(expect.any(String));
    expect(props().webhook.verifyToken.length).toBeGreaterThan(8);
  });

  it.each([
    ["P1", lectura()],
    ["P2", conApp({ webhookAppVerificadoEn: AHORA })],
    ["P4", conectada()],
    ["G", conectada({ primeraRespuestaEn: AHORA })],
  ] as const)("en %s no va el webhook", async (paso, entrada) => {
    h.leer.mockResolvedValue(entrada);

    await pintar();

    expect(props().paso).toBe(paso);
    expect(props().webhook).toBeUndefined();
  });

  it("sin sitio https no hay webhook que mostrar, pero la pantalla abre", async () => {
    h.leer.mockResolvedValue(conApp({ estado: "suscripta" }));
    delete process.env.NEXT_PUBLIC_SITE_URL;

    await pintar();

    expect(props().paso).toBe("E14");
    expect(props().webhook).toBeUndefined();
  });
});

describe("lo secreto no baja al navegador", () => {
  it.each([
    ["P1B", conApp()],
    ["E14", conApp({ estado: "suscripta" })],
    ["P2", conApp({ webhookAppVerificadoEn: AHORA })],
    ["P4", conectada()],
    ["G", conectada({ primeraRespuestaEn: AHORA })],
    ["E5", conApp({ estado: "vinculada", numeroMeta: "+5491100000000", webhookAppVerificadoEn: AHORA })],
  ] as const)("en %s ni el secreto de la app, ni el token, ni el PIN, ni el CUIT", async (paso, entrada) => {
    h.leer.mockResolvedValue({ ...entrada, token: entrada.token ?? TOKEN, pin: entrada.pin ?? PIN });

    const { container } = await pintar();

    expect(props().paso).toBe(paso);
    const todo = container.innerHTML;
    for (const secreto of [SECRETO, TOKEN, PIN, CUIT, "Aseguradora Sur S.A."]) expect(todo).not.toContain(secreto);
  });

  it("fuera de P1B y E14 tampoco la ruta ni el slug del espacio", async () => {
    h.leer.mockResolvedValue(conectada());

    const { container } = await pintar();

    expect(container.innerHTML).not.toContain(RUTA);
    expect(container.innerHTML).not.toContain(SLUG);
  });

  it("el estado que baja es el público: sin ruta, sin secreto y sin slug", async () => {
    h.leer.mockResolvedValue(conectada());

    await pintar();

    expect(Object.keys(props().estado).sort()).toEqual(
      [
        "appId",
        "datosApp",
        "estado",
        "falla",
        "nombreEstado",
        "numero",
        "paso",
        "plantilla",
        "primerMensaje",
        "primeraRespuesta",
        "puedeEnviar",
        "webhookVerificado",
      ].sort()
    );
  });
});

describe("la configuración de la ruta", () => {
  it("dura lo que una acción larga: conectar encadena varias llamadas a Graph", () => {
    expect(maxDuration).toBe(60);
  });
});
