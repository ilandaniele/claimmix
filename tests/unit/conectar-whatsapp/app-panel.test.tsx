/**
 * El asistente de «app propia» (`AppPropiaPanel`): una pantalla por paso (P0, P1, P1B, E14, P2, P3, P4, G
 * y «seguir») y las ventanas de lo que puede salir distinto (E2 a E12).
 *
 * Las acciones del servidor y `useRouter` están simulados; lo que se prueba es qué pide cada pantalla,
 * qué hace con lo que el servidor contesta (ventana, cartel, campo vaciado, `router.refresh`) y cómo corre
 * el sondeo. Los textos salen del diccionario, así que se piden con `esAR[...]` y no se repiten acá.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  iniciar: vi.fn(),
  credenciales: vi.fn(),
  webhook: vi.fn(),
  token: vi.fn(),
  nombre: vi.fn(),
  estado: vi.fn(),
  aceptar: vi.fn(),
  codigo: vi.fn(),
  pin: vi.fn(),
  reintentar: vi.fn(),
  cancelacion: vi.fn(),
  desconectar: vi.fn(),
  cancelarApp: vi.fn(),
  refresh: vi.fn(),
  copiar: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("@/app/conectar-whatsapp/actions", () => ({
  iniciarAppPropia: h.iniciar,
  credencialesDeAppPropia: h.credenciales,
  webhookDeAppPropia: h.webhook,
  tokenDeAppPropia: h.token,
  nombreDeAppPropia: h.nombre,
  estadoDeAppPropia: h.estado,
  aceptarNumeroDeMeta: h.aceptar,
  codigoDeWabaPropia: h.codigo,
  pinDeWabaPropia: h.pin,
  reintentarWabaPropia: h.reintentar,
  cancelacionDeWabaPropia: h.cancelacion,
  desconectarWabaPropia: h.desconectar,
  cancelarAppPropia: h.cancelarApp,
}));

import { AppPropiaPanel, type AppPropiaPanelProps } from "@/app/conectar-whatsapp/app/AppPropiaPanel";
import { SIGUE_EN, WHATSAPP_MANAGER } from "@/app/conectar-whatsapp/WabaPropiaPanel";
import { enUS, esAR, textosDePagina } from "@/lib/i18n";
import { CATEGORIAS_DE_PERFIL } from "@/lib/whatsapp-categorias";
import type { EstadoDeApp, LegalesDeApp, PasoDelAsistente } from "@/server/alta/app-propia";
import { VERSION_DEL_ANEXO } from "@/server/alta/waba-resultados";

const APP_ID = "123456789012345";
const WABA = "345678901234567";
const NUMERO = "+54 9 11 5555-0000";
const TIPEADO = "+54 9 11 0000-0000";
const CORREO = "operador@example.com";
const AYUDA = `mailto:${CORREO}?subject=Ayuda`;
const TOKEN = "fake-system-token-1";
const SECRETO = "fake-app-secret-1";
const WEBHOOK = { url: "https://claimmix.example.com/api/webhooks/whatsapp/abc", verifyToken: "fake-verify-token-1" };
const LEGALES: LegalesDeApp = {
  terminos: "https://claimmix.example.com/legal/abcdefghij123456/terminos",
  privacidad: "https://claimmix.example.com/legal/abcdefghij123456/privacidad",
  borrado: "https://claimmix.example.com/legal/abcdefghij123456/borrado",
  contacto: "legal@example.com",
  listos: false,
};

const BASE: EstadoDeApp = {
  paso: "P0",
  estado: null,
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
const estadoDe = (paso: PasoDelAsistente, extra: Partial<EstadoDeApp> = {}): EstadoDeApp => ({ ...BASE, paso, ...extra });

const ok = (resultado: string, extra: object = {}) => ({ resultado, ...extra });

function pintar(extra: Partial<AppPropiaPanelProps> = {}) {
  const props: AppPropiaPanelProps = {
    paso: "P0",
    estado: null,
    numeroTipeado: TIPEADO,
    empresa: "Aseguradora Sur",
    locale: "es-AR",
    textos: textosDePagina(extra.locale ?? "es-AR"),
    ayuda: null,
    ...extra,
  };
  return { ...render(<AppPropiaPanel {...props} />), props };
}

/** Un usuario con el portapapeles falso puesto después de que `userEvent` instale el suyo. */
function usuario(opciones: Parameters<typeof userEvent.setup>[0] = {}) {
  const u = userEvent.setup(opciones);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: h.copiar } });
  return u;
}

function diferido<T>() {
  let resolver!: (valor: T) => void;
  const promesa = new Promise<T>((r) => {
    resolver = r;
  });
  return { promesa, resolver };
}

const boton = (nombre: string) => screen.getByRole("button", { name: nombre });
const titulo = (nombre: string) => screen.getByRole("heading", { name: nombre });
const seccion = (nombre: string) => titulo(nombre).closest("section") as HTMLElement;
const ventana = () => screen.getByRole("dialog");
const sinVentana = () => expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

const avanzar = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const vaciar = () =>
  act(async () => {
    await Promise.resolve();
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.iniciar.mockResolvedValue(ok("listo"));
  h.credenciales.mockResolvedValue(ok("listo"));
  h.webhook.mockResolvedValue(ok("listo", { webhook: { ...WEBHOOK, aviso: null } }));
  h.token.mockResolvedValue(ok("listo"));
  h.nombre.mockResolvedValue(ok("nombre_pendiente"));
  h.estado.mockResolvedValue(ok("esperar"));
  h.aceptar.mockResolvedValue(ok("listo"));
  h.codigo.mockResolvedValue(ok("listo"));
  h.pin.mockResolvedValue(ok("listo"));
  h.reintentar.mockResolvedValue(ok("conectado"));
  h.cancelacion.mockResolvedValue(ok("desconectado"));
  h.desconectar.mockResolvedValue(ok("desconectado"));
  h.cancelarApp.mockResolvedValue(ok("cancelado"));
  h.copiar.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/* ── P0 ───────────────────────────────────────────────────────────────────── */

describe("P0: antes de empezar", () => {
  async function completar(u: ReturnType<typeof usuario>, cuit = "20-12345678-6") {
    await u.type(screen.getByLabelText(esAR["appPropia.antes.razonSocial"]), "Aseguradora Sur SA");
    await u.type(screen.getByLabelText(esAR["appPropia.antes.cuit"]), cuit);
    await u.click(screen.getByLabelText(esAR["appPropia.antes.acuerdo"]));
  }
  const empezar = () => boton(esAR["appPropia.antes.empezar"]);

  it("cuenta qué hace falta y no es un paso numerado", () => {
    pintar();

    expect(titulo(esAR["appPropia.antes.titulo"])).toBeInTheDocument();
    expect(screen.queryByText(/Paso \d de 4/)).not.toBeInTheDocument();
    expect(screen.getByText(esAR["appPropia.antes.necesitasAdmin"])).toBeInTheDocument();
    expect(screen.getByText(esAR["appPropia.antes.necesitasTarjeta"])).toBeInTheDocument();
  });

  it("muestra el número tipeado al registrarse, sin pedirlo de nuevo", () => {
    pintar();

    expect(screen.getByText(esAR["appPropia.antes.numero"].replace("{numero}", TIPEADO))).toBeInTheDocument();
    expect(screen.queryByLabelText(esAR["appPropia.antes.numeroCampo"])).not.toBeInTheDocument();
  });

  it("sin número tipeado pide el número de entrada", () => {
    pintar({ numeroTipeado: null });

    expect(screen.getByLabelText(esAR["appPropia.antes.numeroCampo"])).toBeInTheDocument();
  });

  it("no deja empezar sin acuerdo, sin razón social o con un CUIT que no tiene 11 números", async () => {
    const u = usuario();
    pintar();
    expect(empezar()).toBeDisabled();

    await u.type(screen.getByLabelText(esAR["appPropia.antes.razonSocial"]), "Aseguradora Sur SA");
    await u.type(screen.getByLabelText(esAR["appPropia.antes.cuit"]), "2012345678");
    await u.click(screen.getByLabelText(esAR["appPropia.antes.acuerdo"]));
    expect(empezar()).toBeDisabled();

    await u.type(screen.getByLabelText(esAR["appPropia.antes.cuit"]), "6");
    expect(empezar()).toBeEnabled();

    await u.click(screen.getByLabelText(esAR["appPropia.antes.acuerdo"]));
    expect(empezar()).toBeDisabled();

    await u.click(screen.getByLabelText(esAR["appPropia.antes.acuerdo"]));
    await u.clear(screen.getByLabelText(esAR["appPropia.antes.razonSocial"]));
    await u.type(screen.getByLabelText(esAR["appPropia.antes.razonSocial"]), "   ");
    expect(empezar()).toBeDisabled();
  });

  it("manda el acuerdo con la versión del anexo y los datos sin espacios, sin número si no se cambió", async () => {
    const u = usuario();
    pintar();
    await completar(u);

    await u.click(empezar());

    expect(h.iniciar).toHaveBeenCalledOnce();
    const entrada = h.iniciar.mock.calls[0][0];
    expect(entrada).toMatchObject({ acuerdo: VERSION_DEL_ANEXO, razonSocial: "Aseguradora Sur SA", cuit: "20-12345678-6" });
    expect(entrada.numero).toBeUndefined();
  });

  it("manda el número nuevo, recortado, cuando se lo cambia", async () => {
    const u = usuario();
    pintar();
    await completar(u);

    await u.click(boton(esAR["appPropia.antes.cambiarNumero"]));
    await u.type(screen.getByLabelText(esAR["appPropia.antes.numeroCampo"]), " +54 9 11 9999-0000 ");
    await u.click(empezar());

    expect(h.iniciar.mock.calls[0][0].numero).toBe("+54 9 11 9999-0000");
  });

  it("sin número tipeado manda el que se escribió", async () => {
    const u = usuario();
    pintar({ numeroTipeado: null });
    await completar(u);

    await u.type(screen.getByLabelText(esAR["appPropia.antes.numeroCampo"]), "+54 9 291 642-6930");
    await u.click(empezar());

    expect(h.iniciar.mock.calls[0][0].numero).toBe("+54 9 291 642-6930");
  });

  it("también se envía con Enter, pero no si falta algo", async () => {
    const u = usuario();
    pintar();
    await u.type(screen.getByLabelText(esAR["appPropia.antes.razonSocial"]), "Aseguradora Sur SA{Enter}");
    expect(h.iniciar).not.toHaveBeenCalled();

    await u.type(screen.getByLabelText(esAR["appPropia.antes.cuit"]), "20-12345678-6");
    await u.click(screen.getByLabelText(esAR["appPropia.antes.acuerdo"]));
    await u.type(screen.getByLabelText(esAR["appPropia.antes.cuit"]), "{Enter}");

    expect(h.iniciar).toHaveBeenCalledOnce();
  });

  it("lleva al anexo en una pestaña nueva, sin pasarle de dónde viene", () => {
    pintar();

    const enlace = screen.getByRole("link", { name: esAR["appPropia.antes.verAnexo"] });
    expect(enlace).toHaveAttribute("href", "/terms#app-propia");
    expect(enlace).toHaveAttribute("target", "_blank");
    expect(enlace.getAttribute("rel")).toMatch(/noopener/);
    expect(enlace.getAttribute("rel")).toMatch(/noreferrer/);
  });

  it("mientras espera al servidor apaga el botón, y al terminar pide la página nueva", async () => {
    const u = usuario();
    const espera = diferido<object>();
    h.iniciar.mockReturnValue(espera.promesa);
    pintar();
    await completar(u);

    await u.click(empezar());
    expect(boton(esAR["waba.cargando"])).toBeDisabled();

    await act(async () => espera.resolver(ok("listo")));
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("con un resultado de error muestra el cartel y deja lo escrito", async () => {
    const u = usuario();
    h.iniciar.mockResolvedValue(ok("cuit_invalido"));
    pintar();
    await completar(u);

    await u.click(empezar());

    expect(screen.getByRole("alert")).toHaveTextContent(esAR["appPropia.r.cuit_invalido"]);
    expect(screen.getByLabelText(esAR["appPropia.antes.cuit"])).toHaveValue("20-12345678-6");
    expect(empezar()).toBeEnabled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("si la llamada al servidor se cae, dice lo genérico de Meta y deja volver a probar", async () => {
    const u = usuario();
    h.iniciar.mockRejectedValue(new Error("red"));
    pintar();
    await completar(u);

    await u.click(empezar());

    expect(screen.getByRole("alert")).toHaveTextContent(esAR["waba.r.meta"]);
    expect(empezar()).toBeEnabled();
  });
});

/* ── P1 ───────────────────────────────────────────────────────────────────── */

describe("P1: crear la app y pegar sus claves", () => {
  const validar = () => boton(esAR["appPropia.validar"]);
  const campoApp = () => screen.getByLabelText(esAR["appPropia.claves.campoApp"]);
  const campoSecreto = () => screen.getByLabelText(esAR["appPropia.claves.campoSecreto"]);

  it("es el paso 1 de 4 y propone el nombre de la app con el del espacio", () => {
    pintar({ paso: "P1" });

    expect(screen.getByText("Paso 1 de 4")).toBeInTheDocument();
    expect(screen.getByText(/Aseguradora Sur Siniestros/)).toBeInTheDocument();
  });

  it("la clave secreta es un campo de contraseña que el navegador no recuerda", () => {
    pintar({ paso: "P1" });

    expect(campoSecreto()).toHaveAttribute("type", "password");
    expect(campoSecreto()).toHaveAttribute("autocomplete", "off");
    expect(campoApp()).toHaveAttribute("type", "text");
  });

  it("no valida con un campo vacío y manda los dos sin espacios", async () => {
    const u = usuario();
    pintar({ paso: "P1" });
    expect(validar()).toBeDisabled();

    await u.type(campoApp(), ` ${APP_ID} `);
    expect(validar()).toBeDisabled();
    await u.type(campoSecreto(), ` ${SECRETO} `);
    await u.click(validar());

    expect(h.credenciales).toHaveBeenCalledWith({ appId: APP_ID, secreto: SECRETO });
  });

  it("al guardarse en el servidor vacía la clave secreta y pide la página nueva", async () => {
    const u = usuario();
    pintar({ paso: "P1" });
    await u.type(campoApp(), APP_ID);
    await u.type(campoSecreto(), SECRETO);

    await u.click(validar());

    expect(campoSecreto()).toHaveValue("");
    expect(campoApp()).toHaveValue(APP_ID);
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it("con un error deja la clave escrita para corregirla", async () => {
    const u = usuario();
    h.credenciales.mockResolvedValue(ok("app_invalida"));
    pintar({ paso: "P1" });
    await u.type(campoApp(), APP_ID);
    await u.type(campoSecreto(), SECRETO);

    await u.click(validar());

    expect(campoSecreto()).toHaveValue(SECRETO);
    expect(screen.getByRole("alert")).toHaveTextContent(esAR["appPropia.r.app_invalida"]);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("marca como inválido el campo que el servidor señala", async () => {
    const u = usuario();
    pintar({ paso: "P1" });
    await u.type(campoApp(), "abc");
    await u.type(campoSecreto(), SECRETO);

    h.credenciales.mockResolvedValue(ok("formato_app"));
    await u.click(validar());
    expect(campoApp()).toHaveAttribute("aria-invalid", "true");
    expect(campoSecreto()).not.toHaveAttribute("aria-invalid");

    h.credenciales.mockResolvedValue(ok("formato_secreto"));
    await u.click(validar());
    expect(campoSecreto()).toHaveAttribute("aria-invalid", "true");
    expect(campoApp()).not.toHaveAttribute("aria-invalid");
  });

  it("el cartel de «es un token» manda al paso 3", async () => {
    const u = usuario();
    h.credenciales.mockResolvedValue(ok("parece_token"));
    pintar({ paso: "P1" });
    await u.type(campoApp(), APP_ID);
    await u.type(campoSecreto(), TOKEN);

    await u.click(validar());

    expect(screen.getByRole("alert")).toHaveTextContent(esAR["appPropia.r.parece_token"]);
  });
});

/* ── P1B ──────────────────────────────────────────────────────────────────── */

describe("P1B: completar los datos de la app", () => {
  it("ofrece el ícono para descargar, desde la ruta de ClaimMix", () => {
    pintar({ paso: "P1B", legales: LEGALES });

    const enlace = screen.getByRole("link", { name: esAR["appPropia.completar.descargarIcono"] });
    expect(enlace).toHaveAttribute("href", "/conectar-whatsapp/app/icono");
    expect(enlace).toHaveAttribute("download");
    expect(screen.getByText("Paso 1 de 4")).toBeInTheDocument();
  });

  it("con los datos legales sin cargar ofrece copiar términos, privacidad y contacto, y el borrado", () => {
    pintar({ paso: "P1B", legales: LEGALES });

    expect(screen.getByLabelText("Terms of Service URL")).toHaveValue(LEGALES.terminos);
    expect(screen.getByLabelText("Privacy Policy URL")).toHaveValue(LEGALES.privacidad);
    expect(screen.getByLabelText("Contact email")).toHaveValue(LEGALES.contacto);
    expect(screen.getByLabelText("Data deletion instructions URL")).toHaveValue(LEGALES.borrado);
    expect(screen.getByText(esAR["appPropia.completar.legalesPropios"])).toBeInTheDocument();
  });

  it("con los datos legales ya cargados no pide copiarlos, pero el borrado sigue", () => {
    pintar({ paso: "P1B", legales: { ...LEGALES, listos: true } });

    expect(screen.getByText(esAR["appPropia.completar.legalesListos"])).toBeInTheDocument();
    expect(screen.queryByLabelText("Terms of Service URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Contact email")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Data deletion instructions URL")).toHaveValue(LEGALES.borrado);
  });

  it("sin datos legales (no hay página del espacio) igual muestra la pantalla", () => {
    pintar({ paso: "P1B" });

    expect(titulo(esAR["appPropia.completar.titulo"])).toBeInTheDocument();
    expect(screen.queryByLabelText("Terms of Service URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Data deletion instructions URL")).not.toBeInTheDocument();
  });

  it("sin contacto no ofrece copiar un mail vacío", () => {
    pintar({ paso: "P1B", legales: { ...LEGALES, contacto: null } });

    expect(screen.queryByLabelText("Contact email")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Terms of Service URL")).toBeInTheDocument();
  });

  it("«Seguir» pasa a conectar los avisos sin consultar al servidor", async () => {
    const u = usuario();
    pintar({ paso: "P1B", legales: LEGALES, webhook: WEBHOOK });

    await u.click(boton(esAR["appPropia.seguir"]));

    expect(titulo(esAR["appPropia.webhook.titulo"])).toBeInTheDocument();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("copiar un dato lo manda al portapapeles y avisa un momento", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: h.copiar } });
    pintar({ paso: "P1B", legales: LEGALES });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copiar: Terms of Service URL" }));
    });
    expect(h.copiar).toHaveBeenCalledWith(LEGALES.terminos);
    expect(screen.getByRole("button", { name: "Copiar: Terms of Service URL" })).toHaveTextContent(esAR["appPropia.copiado"]);

    await avanzar(2000);
    expect(screen.getByRole("button", { name: "Copiar: Terms of Service URL" })).toHaveTextContent(esAR["appPropia.copiar"]);
  });

  it("si el navegador no deja copiar, no pasa nada y el dato sigue a la vista", async () => {
    const u = usuario();
    h.copiar.mockRejectedValue(new Error("sin permiso"));
    pintar({ paso: "P1B", legales: LEGALES });

    await u.click(screen.getByRole("button", { name: "Copiar: Privacy Policy URL" }));

    expect(screen.getByRole("button", { name: "Copiar: Privacy Policy URL" })).toHaveTextContent(esAR["appPropia.copiar"]);
    expect(screen.getByLabelText("Privacy Policy URL")).toHaveValue(LEGALES.privacidad);
  });
});

/* ── E14 ──────────────────────────────────────────────────────────────────── */

describe("E14: conectar los avisos de la app", () => {
  const consultasDeEstado = () => h.estado.mock.calls.length;
  const verificada = ok("listo", { ...estadoDe("E14"), webhookVerificado: true });

  it("muestra la dirección y la marca para copiar, que salen de la página", async () => {
    const u = usuario();
    pintar({ paso: "E14", webhook: WEBHOOK });

    expect(screen.getByLabelText("Callback URL")).toHaveValue(WEBHOOK.url);
    expect(screen.getByLabelText("Verify token")).toHaveValue(WEBHOOK.verifyToken);

    await u.click(screen.getByRole("button", { name: "Copiar: Callback URL" }));
    expect(h.copiar).toHaveBeenLastCalledWith(WEBHOOK.url);
    await u.click(screen.getByRole("button", { name: "Copiar: Verify token" }));
    expect(h.copiar).toHaveBeenLastCalledWith(WEBHOOK.verifyToken);
  });

  it("al abrir le pide al servidor revisar el callback que la app ya tiene, y muestra su aviso", async () => {
    h.webhook.mockResolvedValue(ok("listo", { webhook: { ...WEBHOOK, aviso: "ajeno" } }));
    pintar({ paso: "E14", webhook: WEBHOOK });
    await vaciar();

    expect(h.webhook).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent(esAR["appPropia.webhook.ajeno"]);
  });

  it("el aviso de «revisar» tiene su propio texto", async () => {
    h.webhook.mockResolvedValue(ok("listo", { webhook: { ...WEBHOOK, aviso: "revisar" } }));
    pintar({ paso: "E14", webhook: WEBHOOK });
    await vaciar();

    expect(screen.getByRole("alert")).toHaveTextContent(esAR["appPropia.webhook.revisar"]);
  });

  it("sin aviso no hay cartel", async () => {
    pintar({ paso: "E14", webhook: WEBHOOK });
    await vaciar();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("si el servidor no contesta con los datos, deja los que tenía", async () => {
    h.webhook.mockResolvedValue(ok("esperar"));
    pintar({ paso: "E14", webhook: WEBHOOK });
    await vaciar();

    expect(screen.getByLabelText("Callback URL")).toHaveValue(WEBHOOK.url);
  });

  it("si el servidor falla, la pantalla sigue en pie", async () => {
    h.webhook.mockRejectedValue(new Error("red"));
    pintar({ paso: "E14", webhook: WEBHOOK });
    await vaciar();

    expect(screen.getByLabelText("Callback URL")).toHaveValue(WEBHOOK.url);
  });

  it("sin los datos de la página los toma de la contestación del servidor", async () => {
    pintar({ paso: "E14" });
    expect(screen.queryByLabelText("Callback URL")).not.toBeInTheDocument();
    await vaciar();

    expect(screen.getByLabelText("Callback URL")).toHaveValue(WEBHOOK.url);
  });

  it("consulta cada 3 segundos hasta que Meta verifica y entonces pide la página nueva una sola vez", async () => {
    vi.useFakeTimers();
    pintar({ paso: "E14", webhook: WEBHOOK });
    expect(screen.getByText(esAR["appPropia.webhook.esperando"])).toBeInTheDocument();

    await avanzar(3000);
    await avanzar(3000);
    expect(consultasDeEstado()).toBe(2);
    expect(h.refresh).not.toHaveBeenCalled();

    h.estado.mockResolvedValue(verificada);
    await avanzar(3000);
    expect(screen.getByText(esAR["appPropia.webhook.verificado"])).toBeInTheDocument();
    expect(h.refresh).toHaveBeenCalledOnce();

    await avanzar(30_000);
    expect(consultasDeEstado()).toBe(3);
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it("una contestación frenada por el cupo no cuenta como verificada", async () => {
    vi.useFakeTimers();
    h.estado.mockResolvedValue(ok("esperar", { webhookVerificado: true }));
    pintar({ paso: "E14", webhook: WEBHOOK });

    await avanzar(6000);

    expect(h.refresh).not.toHaveBeenCalled();
    expect(screen.queryByText(esAR["appPropia.webhook.verificado"])).not.toBeInTheDocument();
  });

  it("una consulta que falla se repite en la vuelta siguiente", async () => {
    vi.useFakeTimers();
    h.estado.mockRejectedValueOnce(new Error("red"));
    pintar({ paso: "E14", webhook: WEBHOOK });

    await avanzar(3000);
    h.estado.mockResolvedValue(verificada);
    await avanzar(3000);

    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it("pasado un minuto deja de consultar, avisa que Meta no llamó y deja esperar otro minuto", async () => {
    vi.useFakeTimers();
    pintar({ paso: "E14", webhook: WEBHOOK });

    await avanzar(60_000);
    expect(consultasDeEstado()).toBe(20);
    expect(screen.getByRole("alert")).toHaveTextContent(esAR["appPropia.r.webhook_demora"]);

    await avanzar(30_000);
    expect(consultasDeEstado()).toBe(20);

    await act(async () => {
      fireEvent.click(boton(esAR["appPropia.webhook.esperarMas"]));
    });
    expect(screen.queryByText(esAR["appPropia.webhook.esperarMas"])).not.toBeInTheDocument();
    await avanzar(3000);
    expect(consultasDeEstado()).toBe(21);
  });

  it("al desmontarse deja de consultar", async () => {
    vi.useFakeTimers();
    const { unmount } = pintar({ paso: "E14", webhook: WEBHOOK });
    await avanzar(3000);
    unmount();

    await avanzar(30_000);

    expect(consultasDeEstado()).toBe(1);
  });
});

describe("E14 con el webhook ya verificado: el callback de la app cambió", () => {
  const cambiado = estadoDe("seguir", { estado: "suscripta", appId: APP_ID, webhookVerificado: true });

  it("«Seguir» que contesta webhook_pendiente abre E14 con la dirección y la marca, sin pedir la página nueva", async () => {
    const u = usuario();
    h.reintentar.mockResolvedValue(ok("webhook_pendiente"));
    h.webhook.mockResolvedValue(ok("listo", { webhook: { ...WEBHOOK, aviso: "ajeno" } }));
    pintar({ paso: "seguir", estado: cambiado, webhook: WEBHOOK });

    await u.click(boton(esAR["appPropia.seguir"]));

    expect(titulo(esAR["appPropia.webhook.titulo"])).toBeInTheDocument();
    expect(screen.getByLabelText("Callback URL")).toHaveValue(WEBHOOK.url);
    expect(screen.getByLabelText("Verify token")).toHaveValue(WEBHOOK.verifyToken);
    const carteles = () => screen.getAllByRole("alert").map((c) => c.textContent);
    // El cartel llega con la segunda vuelta del efecto de E14: se espera, no se lee en seco.
    await waitFor(() => expect(carteles()).toContain(esAR["appPropia.webhook.ajeno"]));
    // La demora es del sondeo; con el callback ajeno el motivo es el cartel de arriba, no «Meta todavía no nos llamó».
    expect(carteles()).not.toContain(esAR["appPropia.r.webhook_demora"]);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("no espera una verificación que ya está hecha: no consulta el estado y deja seguir a mano", async () => {
    vi.useFakeTimers();
    pintar({ paso: "E14", estado: estadoDe("E14", { webhookVerificado: true }), webhook: WEBHOOK });

    await avanzar(60_000);

    expect(h.estado).not.toHaveBeenCalled();
    expect(screen.queryByText(esAR["appPropia.webhook.verificado"])).not.toBeInTheDocument();
    expect(screen.queryByText(esAR["appPropia.webhook.esperando"])).not.toBeInTheDocument();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("«Seguir» en E14 vuelve a correr el servidor, que mira el callback de nuevo", async () => {
    const u = usuario();
    h.reintentar.mockResolvedValue(ok("conectado"));
    pintar({ paso: "E14", estado: estadoDe("E14", { webhookVerificado: true }), webhook: WEBHOOK });

    await u.click(boton(esAR["appPropia.seguir"]));

    expect(h.reintentar).toHaveBeenCalledOnce();
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it("si el callback sigue ajeno, queda en E14, vuelve a mirarlo y muestra el cartel del callback, no el de la demora", async () => {
    const u = usuario();
    h.reintentar.mockResolvedValue(ok("webhook_pendiente"));
    pintar({ paso: "E14", estado: estadoDe("E14", { webhookVerificado: true }), webhook: WEBHOOK });
    await waitFor(() => expect(h.webhook).toHaveBeenCalledOnce());
    expect(screen.queryByText(esAR["appPropia.webhook.ajeno"])).not.toBeInTheDocument();
    // El callback cambió mientras la pantalla estaba abierta: sólo se entera si la pantalla lo vuelve a mirar.
    h.webhook.mockResolvedValue(ok("listo", { webhook: { ...WEBHOOK, aviso: "ajeno" } }));

    await u.click(boton(esAR["appPropia.seguir"]));

    expect(titulo(esAR["appPropia.webhook.titulo"])).toBeInTheDocument();
    expect(await screen.findByText(esAR["appPropia.webhook.ajeno"])).toBeInTheDocument();
    expect(h.webhook).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(esAR["appPropia.r.webhook_demora"])).not.toBeInTheDocument();
    expect(boton(esAR["appPropia.seguir"])).toBeEnabled();
  });

  it("con la verificación pendiente (la primera vez) sigue el sondeo de siempre y no hay «Seguir»", () => {
    pintar({ paso: "E14", estado: estadoDe("E14"), webhook: WEBHOOK });

    expect(screen.getByText(esAR["appPropia.webhook.esperando"])).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: esAR["appPropia.seguir"] })).not.toBeInTheDocument();
  });
});

/* ── P2 ───────────────────────────────────────────────────────────────────── */

describe("P2: sumar el número", () => {
  const categoria = () => screen.getByLabelText(esAR["waba.antes.categoria"]);

  it("es el paso 2 de 4 y nombra el número del agente", () => {
    pintar({ paso: "P2", estado: estadoDe("P2", { numero: TIPEADO }) });

    expect(screen.getByText("Paso 2 de 4")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(TIPEADO.replace("+", "\\+")))).toBeInTheDocument();
  });

  it("nombra el que se tipeó, no el que Meta informó (tras «Elegir otro» de E5 el estado trae el de Meta)", () => {
    pintar({ paso: "P2", estado: estadoDe("P2", { numero: NUMERO }) });

    expect(screen.getByText(new RegExp(TIPEADO.replace("+", "\\+")))).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(NUMERO.replace("+", "\\+")))).not.toBeInTheDocument();
  });

  it("sin número tipeado usa el del estado", () => {
    pintar({ paso: "P2", estado: estadoDe("P2", { numero: NUMERO }), numeroTipeado: null });

    expect(screen.getByText(new RegExp(NUMERO.replace("+", "\\+")))).toBeInTheDocument();
  });

  it("el rubro sale elegido en «Finanzas» y se puede cambiar por cualquiera de los de Meta", async () => {
    const u = usuario();
    pintar({ paso: "P2", estado: estadoDe("P2") });
    expect(categoria()).toHaveValue("FINANCE");
    expect(screen.getByText(new RegExp(`la más parecida a «${esAR["waba.categoria.FINANCE"]}»`))).toBeInTheDocument();
    // El formulario de Meta está en inglés: la opción se nombra también como la va a ver la persona.
    expect(screen.getByText(new RegExp(`algo como «${enUS["waba.categoria.FINANCE"]}»`))).toBeInTheDocument();
    expect(within(categoria()).getAllByRole("option")).toHaveLength(CATEGORIAS_DE_PERFIL.length);

    await u.selectOptions(categoria(), "HEALTH");

    expect(categoria()).toHaveValue("HEALTH");
    expect(screen.getByText(new RegExp(`la más parecida a «${esAR["waba.categoria.HEALTH"]}»`))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`algo como «${enUS["waba.categoria.HEALTH"]}»`))).toBeInTheDocument();
  });

  it("las opciones van ordenadas por el nombre que ve la persona", () => {
    pintar({ paso: "P2", estado: estadoDe("P2") });

    const nombres = within(categoria())
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    expect(nombres).toEqual([...nombres].sort((a, b) => a.localeCompare(b, "es-AR")));
  });

  it("«Seguir» pasa al paso 3 sin tocar el servidor", async () => {
    const u = usuario();
    pintar({ paso: "P2", estado: estadoDe("P2", { appId: APP_ID }) });

    await u.click(boton(esAR["appPropia.seguir"]));

    expect(screen.getByText("Paso 3 de 4")).toBeInTheDocument();
    expect(titulo(esAR["appPropia.usuario.titulo"])).toBeInTheDocument();
    expect(h.token).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});

/* ── P3 ───────────────────────────────────────────────────────────────────── */

describe("P3: usuario del sistema y token", () => {
  const campoToken = () => screen.getByLabelText(esAR["appPropia.token.campo"]);
  const campoWaba = () => screen.getByLabelText(esAR["appPropia.token.wabaCampo"]);
  const validar = () => boton(esAR["appPropia.validar"]);

  async function hastaP3(estado: EstadoDeApp = estadoDe("P2", { appId: APP_ID, numero: NUMERO })) {
    const u = usuario();
    pintar({ paso: "P2", estado });
    await u.click(boton(esAR["appPropia.seguir"]));
    return u;
  }
  async function pegar(u: ReturnType<typeof usuario>) {
    await u.type(campoToken(), ` ${TOKEN} `);
    await u.type(campoWaba(), ` ${WABA} `);
  }

  it("tiene tres bloques y el token es un campo de contraseña", async () => {
    await hastaP3();

    expect(seccion(esAR["appPropia.usuario.bloque1"])).toBeInTheDocument();
    expect(seccion(esAR["appPropia.usuario.bloque2"])).toBeInTheDocument();
    expect(seccion(esAR["appPropia.token.bloque3"])).toBeInTheDocument();
    expect(campoToken()).toHaveAttribute("type", "password");
    expect(campoToken()).toHaveAttribute("autocomplete", "off");
    expect(campoWaba()).toHaveAttribute("type", "text");
  });

  it("no valida con un campo vacío y manda el token y el ID de la cuenta sin espacios", async () => {
    const u = await hastaP3();
    expect(validar()).toBeDisabled();
    await u.type(campoToken(), TOKEN);
    expect(validar()).toBeDisabled();
    await u.type(campoWaba(), WABA);
    expect(validar()).toBeEnabled();

    await u.click(validar());

    expect(h.token).toHaveBeenCalledWith({ token: TOKEN, wabaId: WABA, phoneNumberId: undefined, categoria: "FINANCE" });
  });

  it("el rubro que se eligió en el paso 2 viaja con el token, y no se pierde al elegir el número", async () => {
    const u = usuario();
    pintar({ paso: "P2", estado: estadoDe("P2", { appId: APP_ID, numero: NUMERO }) });
    await u.selectOptions(screen.getByLabelText(esAR["waba.antes.categoria"]), "HEALTH");
    await u.click(boton(esAR["appPropia.seguir"]));
    await pegar(u);

    await u.click(validar());

    expect(h.token).toHaveBeenCalledWith({ token: TOKEN, wabaId: WABA, phoneNumberId: undefined, categoria: "HEALTH" });
  });

  it("recorta los espacios del token y del ID", async () => {
    const u = await hastaP3();
    await pegar(u);

    await u.click(validar());

    expect(h.token).toHaveBeenCalledWith({ token: TOKEN, wabaId: WABA, phoneNumberId: undefined, categoria: "FINANCE" });
  });

  it("cuando el servidor guardó el token lo vacía del campo y pide la página nueva", async () => {
    const u = await hastaP3();
    await pegar(u);

    await u.click(validar());

    expect(campoToken()).toHaveValue("");
    expect(campoWaba()).toHaveValue(` ${WABA} `);
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it("con un error deja el token escrito", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValue(ok("token_vencido"));
    await pegar(u);

    await u.click(validar());

    expect(campoToken()).toHaveValue(` ${TOKEN} `);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("el aviso de que la cuenta no está asignada va en el bloque 2", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValue(ok("waba_no_asignada"));
    await pegar(u);

    await u.click(validar());

    const bloque2 = seccion(esAR["appPropia.usuario.bloque2"]);
    expect(within(bloque2).getByRole("alert")).toHaveTextContent(esAR["appPropia.r.waba_no_asignada"]);
    expect(within(seccion(esAR["appPropia.token.bloque3"])).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("el aviso del formato del ID va junto al campo del ID", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValue(ok("waba_formato"));
    await pegar(u);

    await u.click(validar());

    const alerta = screen.getByRole("alert");
    expect(alerta).toHaveTextContent(esAR["appPropia.r.waba_formato"]);
    expect(campoWaba()).toHaveAttribute("aria-invalid", "true");
    expect(campoToken()).not.toHaveAttribute("aria-invalid");
    expect(campoWaba().compareDocumentPosition(alerta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("el aviso de un token malo va junto al campo del token, antes del ID", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValue(ok("token_formato"));
    await pegar(u);

    await u.click(validar());

    const alerta = screen.getByRole("alert");
    expect(alerta).toHaveTextContent(esAR["appPropia.r.token_formato"]);
    expect(campoToken()).toHaveAttribute("aria-invalid", "true");
    expect(alerta.compareDocumentPosition(campoWaba()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("completa el permiso que falta, los que sobran y la app de la que tiene que ser el token", async () => {
    const u = await hastaP3();
    await pegar(u);

    h.token.mockResolvedValue(ok("falta_permiso", { permiso: "whatsapp_business_messaging" }));
    await u.click(validar());
    expect(screen.getByRole("alert")).toHaveTextContent("Al token le falta el permiso whatsapp_business_messaging");

    h.token.mockResolvedValue(ok("permisos_de_mas", { permisos: ["business_management", "ads_read"] }));
    await u.click(validar());
    expect(screen.getByRole("alert")).toHaveTextContent("business_management, ads_read");

    h.token.mockResolvedValue(ok("token_de_otra_app"));
    await u.click(validar());
    expect(screen.getByRole("alert")).toHaveTextContent(`eligiendo la app ${APP_ID}`);
  });

  it("E2: con varios números en la cuenta abre la lista y vuelve a mandar el token con el elegido", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValueOnce(
      ok("elegir_numero", {
        numeros: [
          { id: "pn-1", display: "+54 9 11 1111-1111" },
          { id: "pn-2", display: "+54 9 11 2222-2222" },
        ],
      })
    );
    await pegar(u);

    await u.click(validar());

    const dialogo = ventana();
    expect(within(dialogo).getByText(esAR["appPropia.elegir.titulo"])).toBeInTheDocument();
    expect(within(dialogo).getByText("+54 9 11 2222-2222")).toBeInTheDocument();
    expect(campoToken()).toHaveValue(` ${TOKEN} `);
    expect(h.refresh).not.toHaveBeenCalled();

    await u.click(within(dialogo).getAllByRole("button", { name: esAR["appPropia.elegir.usar"] })[1]);

    expect(h.token).toHaveBeenLastCalledWith({ token: TOKEN, wabaId: WABA, phoneNumberId: "pn-2", categoria: "FINANCE" });
    sinVentana();
  });

  it("E2 se puede cancelar", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValueOnce(ok("elegir_numero", { numeros: [{ id: "pn-1", display: "+54 9 11 1111-1111" }] }));
    await pegar(u);
    await u.click(validar());

    await u.click(within(ventana()).getByRole("button", { name: esAR["waba.cancelar"] }));

    sinVentana();
    expect(h.token).toHaveBeenCalledOnce();
  });

  it("E3: si falta verificar el número abre el código, vacía el token y pide SMS o llamada", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValue(ok("falta_codigo"));
    await pegar(u);

    await u.click(validar());

    expect(within(ventana()).getByText(esAR["waba.codigo.titulo"])).toBeInTheDocument();
    expect(campoToken()).toHaveValue("");
    expect(h.refresh).toHaveBeenCalledOnce();

    h.codigo.mockResolvedValue(ok("codigo_enviado"));
    await u.click(within(ventana()).getByRole("button", { name: esAR["waba.codigo.sms"] }));
    expect(h.codigo).toHaveBeenLastCalledWith({ accion: "SMS" });
    expect(within(ventana()).getByRole("status")).toHaveTextContent(esAR["waba.r.codigo_enviado"]);

    await u.click(within(ventana()).getByRole("button", { name: esAR["waba.codigo.llamada"] }));
    expect(h.codigo).toHaveBeenLastCalledWith({ accion: "VOICE" });
  });

  it("E3: el código se manda sin espacios y recién con seis números", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValue(ok("falta_codigo"));
    await pegar(u);
    await u.click(validar());
    const verificar = () => within(ventana()).getByRole("button", { name: esAR["waba.codigo.enviar"] });
    expect(verificar()).toBeDisabled();

    await u.type(within(ventana()).getByLabelText(esAR["waba.codigo.campo"]), "123 45");
    expect(verificar()).toBeDisabled();
    await u.type(within(ventana()).getByLabelText(esAR["waba.codigo.campo"]), "6");
    await u.click(verificar());

    expect(h.codigo).toHaveBeenLastCalledWith({ accion: "verificar", codigo: "123456" });
    sinVentana();
  });

  it("E3: un código incorrecto deja la ventana abierta con el cartel", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValue(ok("falta_codigo"));
    await pegar(u);
    await u.click(validar());
    h.codigo.mockResolvedValue(ok("codigo_incorrecto"));

    await u.type(within(ventana()).getByLabelText(esAR["waba.codigo.campo"]), "123456");
    await u.click(within(ventana()).getByRole("button", { name: esAR["waba.codigo.enviar"] }));

    expect(within(ventana()).getByRole("alert")).toHaveTextContent(esAR["waba.r.codigo_incorrecto"]);
  });

  it("E4: si falta el PIN abre su ventana; el PIN es una contraseña de seis números y un PIN malo deja la ventana", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValue(ok("falta_pin"));
    await pegar(u);
    await u.click(validar());

    const pin = within(ventana()).getByLabelText(esAR["waba.pin.campo"]);
    expect(pin).toHaveAttribute("type", "password");
    expect(campoToken()).toHaveValue("");

    h.pin.mockResolvedValue(ok("pin_incorrecto"));
    await u.type(pin, "654321");
    await u.click(within(ventana()).getByRole("button", { name: esAR["waba.pin.enviar"] }));

    expect(h.pin).toHaveBeenCalledWith({ pin: "654321" });
    expect(within(ventana()).getByRole("alert")).toHaveTextContent(esAR["waba.r.pin_incorrecto"]);
    expect(within(ventana()).getByText(esAR["appPropia.pin.olvide"])).toBeInTheDocument();
  });

  it("E4: un PIN bueno cierra la ventana y pide la página nueva", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValue(ok("falta_pin"));
    await pegar(u);
    await u.click(validar());

    await u.type(within(ventana()).getByLabelText(esAR["waba.pin.campo"]), "654321");
    await u.click(within(ventana()).getByRole("button", { name: esAR["waba.pin.enviar"] }));

    sinVentana();
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it("E5: si Meta informó otro número ofrece usarlo o empezar de nuevo", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValue(ok("numero_distinto", { numeroMeta: "+54 9 11 7777-7777" }));
    await pegar(u);

    await u.click(validar());

    const dialogo = ventana();
    expect(dialogo).toHaveTextContent("+54 9 11 7777-7777");
    expect(dialogo).toHaveTextContent(esAR["appPropia.distinto.prueba"]);
    expect(campoToken()).toHaveValue("");

    await u.click(within(dialogo).getByRole("button", { name: esAR["waba.distinto.usar"] }));
    expect(h.aceptar).toHaveBeenCalledOnce();
  });

  it("E5: «Elegir otro» no desconecta: cierra la ventana y vuelve al paso 2", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValue(ok("numero_distinto", { numeroMeta: "+54 9 11 7777-7777" }));
    await pegar(u);
    await u.click(validar());

    await u.click(within(ventana()).getByRole("button", { name: esAR["waba.distinto.otro"] }));

    expect(h.desconectar).not.toHaveBeenCalled();
    sinVentana();
    expect(screen.getByText("Paso 2 de 4")).toBeInTheDocument();
    expect(screen.queryByText(/7777-7777/)).not.toBeInTheDocument();
  });

  it("E9: con el número en la app WhatsApp Business no ofrece reintentar, porque todavía no hay nada guardado", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValue(ok("coexistencia"));
    await pegar(u);

    await u.click(validar());

    expect(ventana()).toHaveTextContent(esAR["waba.r.coexistencia"]);
    expect(within(ventana()).queryByRole("button", { name: esAR["waba.reintentar"] })).not.toBeInTheDocument();
    await u.click(within(ventana()).getByRole("button", { name: esAR["appPropia.cerrar"] }));
    sinVentana();
  });

  it("E11: «esperar» abre el aviso sin pedir la página nueva", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValue(ok("esperar"));
    await pegar(u);

    await u.click(validar());

    expect(ventana()).toHaveTextContent(esAR["waba.r.esperar"]);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("E8, E10 y E12 que llegan al validar abren su ventana", async () => {
    const u = await hastaP3();
    await pegar(u);

    h.token.mockResolvedValue(ok("pago_pendiente"));
    await u.click(validar());
    expect(ventana()).toHaveTextContent(esAR["appPropia.r.pago_pendiente"]);
    await u.click(within(ventana()).getByRole("button", { name: esAR["appPropia.cerrar"] }));

    h.token.mockResolvedValue(ok("waba_restringida"));
    await u.click(validar());
    expect(ventana()).toHaveTextContent(esAR["appPropia.r.waba_restringida"]);
    await u.click(within(ventana()).getByRole("button", { name: esAR["appPropia.cerrar"] }));

    h.token.mockResolvedValue(ok("waba_bloqueada"));
    await u.click(validar());
    expect(ventana()).toHaveTextContent(esAR["appPropia.r.waba_bloqueada"]);
  });

  it("con una ventana abierta el cartel no se repite en la pantalla de atrás", async () => {
    const u = await hastaP3();
    h.token.mockResolvedValue(ok("coexistencia"));
    await pegar(u);

    await u.click(validar());

    expect(within(ventana()).queryAllByRole("alert")).toHaveLength(0);
    expect(screen.queryAllByRole("alert").filter((a) => !ventana().contains(a))).toHaveLength(0);
  });
});

/* ── P4 ───────────────────────────────────────────────────────────────────── */

describe("P4: probar", () => {
  const inicial = estadoDe("P4", { estado: "conectada", appId: APP_ID, numero: NUMERO });
  const consultas = () => h.estado.mock.calls.length;
  const delSondeo = (extra: Partial<EstadoDeApp>) => ok("listo", { ...inicial, ...extra });

  it("es el paso 4 de 4 y le dice a la persona a qué número escribir", () => {
    pintar({ paso: "P4", estado: inicial });

    expect(screen.getByText("Paso 4 de 4")).toBeInTheDocument();
    expect(screen.getByText(esAR["appPropia.prueba.texto"].replace("{numero}", NUMERO))).toBeInTheDocument();
    expect(screen.getByText(esAR["appPropia.prueba.esperandoMensaje"])).toBeInTheDocument();
    expect(screen.getByRole("link", { name: esAR["waba.estado.pagoEnlace"] })).toHaveAttribute("href", WHATSAPP_MANAGER);
  });

  it("consulta cada 5 segundos y cuenta cuándo llegó el mensaje", async () => {
    vi.useFakeTimers();
    pintar({ paso: "P4", estado: inicial });

    await avanzar(5000);
    expect(consultas()).toBe(1);
    expect(screen.getByText(esAR["appPropia.prueba.esperandoMensaje"])).toBeInTheDocument();

    h.estado.mockResolvedValue(delSondeo({ primerMensaje: true }));
    await avanzar(5000);

    expect(screen.getByText(esAR["appPropia.prueba.esperandoRespuesta"])).toBeInTheDocument();
  });

  it("recién con la respuesta del agente se pone verde y ofrece seguir; ahí deja de consultar", async () => {
    vi.useFakeTimers();
    pintar({ paso: "P4", estado: inicial });
    h.estado.mockResolvedValue(delSondeo({ primerMensaje: true }));
    await avanzar(5000);
    expect(screen.queryByText(esAR["appPropia.prueba.listo"])).not.toBeInTheDocument();

    h.estado.mockResolvedValue(delSondeo({ primerMensaje: true, primeraRespuesta: true }));
    await avanzar(5000);

    expect(screen.getByRole("status", { name: "" })).toBeInTheDocument();
    expect(screen.getByText(esAR["appPropia.prueba.listo"])).toBeInTheDocument();
    expect(screen.getByRole("link", { name: esAR["appPropia.seguir"] })).toHaveAttribute("href", SIGUE_EN);

    const hasta = consultas();
    await avanzar(60_000);
    expect(consultas()).toBe(hasta);
  });

  it("si ya venía con la respuesta no consulta nunca", async () => {
    vi.useFakeTimers();
    pintar({ paso: "P4", estado: { ...inicial, primerMensaje: true, primeraRespuesta: true } });

    await avanzar(60_000);

    expect(consultas()).toBe(0);
    expect(screen.getByText(esAR["appPropia.prueba.listo"])).toBeInTheDocument();
  });

  it("a los 2 minutos sin mensaje lista qué revisar", async () => {
    vi.useFakeTimers();
    pintar({ paso: "P4", estado: inicial });
    await avanzar(115_000);
    expect(screen.queryByText(esAR["appPropia.prueba.sinMensaje"])).not.toBeInTheDocument();

    await avanzar(5000);

    expect(screen.getByRole("alert")).toHaveTextContent(esAR["appPropia.prueba.sinMensaje"]);
    expect(screen.getByText(esAR["appPropia.prueba.live"])).toBeInTheDocument();
    expect(screen.getByText(esAR["appPropia.prueba.destino"].replace("{numero}", NUMERO))).toBeInTheDocument();
    expect(screen.queryByText(esAR["appPropia.prueba.demora"])).not.toBeInTheDocument();
  });

  it("a los 2 minutos con mensaje pero sin respuesta manda al medio de pago", async () => {
    vi.useFakeTimers();
    pintar({ paso: "P4", estado: inicial });
    h.estado.mockResolvedValue(delSondeo({ primerMensaje: true }));

    await avanzar(120_000);

    const cartel = screen.getByRole("alert");
    expect(cartel).toHaveTextContent(esAR["appPropia.prueba.sinRespuesta"]);
    expect(within(cartel).getByRole("link", { name: esAR["waba.estado.pagoEnlace"] })).toHaveAttribute("href", WHATSAPP_MANAGER);
    expect(screen.queryByText(esAR["appPropia.prueba.sinMensaje"])).not.toBeInTheDocument();
  });

  it("a los 10 minutos deja de consultar y ofrece esperar otros 10", async () => {
    vi.useFakeTimers();
    pintar({ paso: "P4", estado: inicial });

    await avanzar(600_000);
    expect(consultas()).toBe(120);
    expect(screen.getByText(esAR["appPropia.prueba.demora"])).toBeInTheDocument();

    await avanzar(60_000);
    expect(consultas()).toBe(120);

    await act(async () => {
      fireEvent.click(boton(esAR["appPropia.prueba.otraVez"]));
    });
    expect(screen.queryByText(esAR["appPropia.prueba.demora"])).not.toBeInTheDocument();
    await avanzar(5000);
    expect(consultas()).toBe(121);
  });

  it("un rechazo por pago en la primera respuesta abre el aviso una sola vez y sigue esperando", async () => {
    vi.useFakeTimers();
    pintar({ paso: "P4", estado: inicial });
    h.estado.mockResolvedValue(delSondeo({ primerMensaje: true, estado: "falla", falla: "pago_pendiente" }));

    await avanzar(5000);

    expect(ventana()).toHaveTextContent(esAR["appPropia.r.pago_pendiente"]);
    expect(within(ventana()).getByRole("link", { name: esAR["waba.estado.pagoEnlace"] })).toHaveAttribute("href", WHATSAPP_MANAGER);

    await act(async () => {
      fireEvent.click(within(ventana()).getByRole("button", { name: esAR["appPropia.cerrar"] }));
    });
    sinVentana();
    const hasta = consultas();
    await avanzar(10_000);
    expect(consultas()).toBe(hasta + 2);
    sinVentana();
  });

  it("una contestación frenada por el cupo no cambia lo que se ve", async () => {
    vi.useFakeTimers();
    pintar({ paso: "P4", estado: { ...inicial, primerMensaje: true } });

    await avanzar(10_000);

    expect(screen.getByText(esAR["appPropia.prueba.esperandoRespuesta"])).toBeInTheDocument();
  });
});

/* ── G ────────────────────────────────────────────────────────────────────── */

describe("G: conectado", () => {
  const conectado = estadoDe("G", {
    estado: "conectada",
    appId: APP_ID,
    numero: NUMERO,
    plantilla: true,
    primerMensaje: true,
    primeraRespuesta: true,
    puedeEnviar: "AVAILABLE",
    nombreEstado: "APPROVED",
  });

  it("dice el número conectado, la app y cómo viene todo", () => {
    pintar({ paso: "G", estado: conectado });

    expect(screen.getByRole("status")).toHaveTextContent(esAR["waba.conectado.texto"].replace("{numero}", NUMERO));
    expect(screen.getByText(esAR["appPropia.estado.app"].replace("{appId}", APP_ID))).toBeInTheDocument();
    expect(screen.getByText(`${esAR["appPropia.estado.mensajes"]}: ${esAR["appPropia.estado.mensajesOk"]}`)).toBeInTheDocument();
    expect(screen.getByText(`${esAR["appPropia.estado.envio"]}: ${esAR["appPropia.estado.envio.AVAILABLE"]}`)).toBeInTheDocument();
    expect(screen.getByText(esAR["waba.estado.nombre.aprobado"])).toBeInTheDocument();
    expect(screen.getByText(esAR["waba.estado.plantilla.enviada"])).toBeInTheDocument();
    expect(screen.getByText(esAR["appPropia.estado.responsable"])).toBeInTheDocument();
    expect(screen.getByRole("link", { name: esAR["waba.seguir"] })).toHaveAttribute("href", SIGUE_EN);
    sinVentana();
  });

  it("antes del primer mensaje y de enviar la plantilla lo dice", () => {
    pintar({ paso: "G", estado: { ...conectado, primerMensaje: false, plantilla: false, nombreEstado: null, puedeEnviar: null } });

    expect(screen.getByText(`${esAR["appPropia.estado.mensajes"]}: ${esAR["appPropia.estado.mensajesPendiente"]}`)).toBeInTheDocument();
    expect(screen.getByText(esAR["waba.estado.plantilla.pendiente"])).toBeInTheDocument();
    expect(screen.getByText(esAR["waba.estado.nombre.sin"])).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(esAR["appPropia.estado.envio"]))).not.toBeInTheDocument();
  });

  it.each(["LIMITED", "BLOCKED"] as const)("el envío %s se cuenta con su texto", (valor) => {
    pintar({ paso: "G", estado: { ...conectado, puedeEnviar: valor } });

    expect(screen.getByText(`${esAR["appPropia.estado.envio"]}: ${esAR[`appPropia.estado.envio.${valor}`]}`)).toBeInTheDocument();
  });

  it("un estado de envío desconocido no se muestra", () => {
    pintar({ paso: "G", estado: { ...conectado, puedeEnviar: "__proto__" } });

    expect(screen.queryByText(new RegExp(esAR["appPropia.estado.envio"]))).not.toBeInTheDocument();
  });

  it("el nombre en revisión y el no aprobado tienen su texto; sólo el no aprobado deja cambiarlo", () => {
    const { unmount } = pintar({ paso: "G", estado: { ...conectado, nombreEstado: "PENDING_REVIEW" } });
    expect(screen.getByText(esAR["waba.estado.nombre.revision"])).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: esAR["appPropia.nombre.cambiar"] })).not.toBeInTheDocument();
    unmount();

    pintar({ paso: "G", estado: { ...conectado, nombreEstado: "DECLINED" } });
    expect(screen.getByText(esAR["waba.estado.nombre.otro"])).toBeInTheDocument();
    expect(boton(esAR["appPropia.nombre.cambiar"])).toBeInTheDocument();
  });

  it("E10: manda otro nombre visible a revisión, recortado, y la ventana queda con el aviso", async () => {
    const u = usuario();
    pintar({ paso: "G", estado: { ...conectado, nombreEstado: "DECLINED" }, empresa: "N".repeat(90) });
    await u.click(boton(esAR["appPropia.nombre.cambiar"]));

    const campo = within(ventana()).getByLabelText(esAR["appPropia.nombre.campo"]);
    expect(campo).toHaveValue("N".repeat(60));
    await u.clear(campo);
    await u.type(campo, "  Sur Seguros  ");
    await u.click(within(ventana()).getByRole("button", { name: esAR["appPropia.nombre.mandar"] }));

    expect(h.nombre).toHaveBeenCalledWith({ nombre: "Sur Seguros" });
    expect(within(ventana()).getByRole("status")).toHaveTextContent(esAR["appPropia.r.nombre_pendiente"]);
  });

  it("E10 sin falla guardada (cambiar un nombre en revisión o ya aprobado) no ofrece «Reintentar»", async () => {
    const u = usuario();
    pintar({ paso: "G", estado: { ...conectado, nombreEstado: "DECLINED" } });
    await u.click(boton(esAR["appPropia.nombre.cambiar"]));

    expect(within(ventana()).queryByRole("button", { name: esAR["waba.reintentar"] })).not.toBeInTheDocument();
  });

  describe("el nombre visible rechazado (falla nombre_rechazado)", () => {
    const rechazado = { ...conectado, estado: "falla" as const, falla: "nombre_rechazado", nombreEstado: "DECLINED" };

    it("E10 ofrece «Mandar este nombre» y «Reintentar», que le pregunta a Meta cómo va", async () => {
      const u = usuario();
      h.reintentar.mockResolvedValue(ok("nombre_pendiente"));
      pintar({ paso: "G", estado: rechazado });

      expect(within(ventana()).getByRole("button", { name: esAR["appPropia.nombre.mandar"] })).toBeInTheDocument();
      await u.click(within(ventana()).getByRole("button", { name: esAR["waba.reintentar"] }));

      expect(h.reintentar).toHaveBeenCalledOnce();
      expect(h.nombre).not.toHaveBeenCalled();
      expect(within(ventana()).getByRole("status")).toHaveTextContent(esAR["appPropia.r.nombre_pendiente"]);
    });

    it("si Meta ya aprobó el nombre, «Reintentar» cierra la ventana y vuelve a leer la página", async () => {
      const u = usuario();
      h.reintentar.mockResolvedValue(ok("conectado"));
      pintar({ paso: "G", estado: rechazado });

      await u.click(within(ventana()).getByRole("button", { name: esAR["waba.reintentar"] }));

      sinVentana();
      expect(h.refresh).toHaveBeenCalledOnce();
    });

    it("un nombre que no pasa el formato dice eso y no que Meta lo rechazó", async () => {
      const u = usuario();
      h.nombre.mockResolvedValue(ok("nombre_invalido"));
      pintar({ paso: "G", estado: rechazado });

      await u.click(within(ventana()).getByRole("button", { name: esAR["appPropia.nombre.mandar"] }));

      expect(within(ventana()).getByText(esAR["appPropia.r.nombre_invalido"])).toBeInTheDocument();
    });

    it("en G el botón de la falla es el único camino a E10: no se repite «Cambiar el nombre» ni el texto de la ventana", async () => {
      const u = usuario();
      pintar({ paso: "G", estado: rechazado });
      await u.click(within(ventana()).getByRole("button", { name: esAR["waba.cancelar"] }));

      sinVentana();
      expect(screen.getByText(esAR["appPropia.estado.nombreRechazado"])).toBeInTheDocument();
      expect(screen.queryByText(esAR["appPropia.r.nombre_rechazado"])).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: esAR["appPropia.nombre.cambiar"] })).not.toBeInTheDocument();

      await u.click(boton(esAR["waba.seguirDonde"]));

      expect(within(ventana()).getByRole("heading", { name: esAR["appPropia.nombre.titulo"] })).toBeInTheDocument();
    });
  });

  it("E10: sin nombre no se manda", async () => {
    const u = usuario();
    pintar({ paso: "G", estado: { ...conectado, nombreEstado: "DECLINED" } });
    await u.click(boton(esAR["appPropia.nombre.cambiar"]));

    await u.clear(within(ventana()).getByLabelText(esAR["appPropia.nombre.campo"]));

    expect(within(ventana()).getByRole("button", { name: esAR["appPropia.nombre.mandar"] })).toBeDisabled();
  });

  it("E7: «Cargar la clave secreta nueva» manda la clave con el App ID de la fila y la vacía al guardarse", async () => {
    const u = usuario();
    pintar({ paso: "G", estado: conectado });
    await u.click(boton(esAR["appPropia.estado.actualizarSecreto"]));

    const campo = within(ventana()).getByLabelText(esAR["appPropia.claves.campoSecreto"]);
    expect(campo).toHaveAttribute("type", "password");
    await u.type(campo, ` ${SECRETO} `);
    await u.click(within(ventana()).getByRole("button", { name: esAR["appPropia.validar"] }));

    expect(h.credenciales).toHaveBeenCalledWith({ appId: APP_ID, secreto: SECRETO });
    sinVentana();
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it("E7: con un error deja la clave escrita y el cartel", async () => {
    const u = usuario();
    h.credenciales.mockResolvedValue(ok("app_invalida"));
    pintar({ paso: "G", estado: conectado });
    await u.click(boton(esAR["appPropia.estado.actualizarSecreto"]));

    const campo = within(ventana()).getByLabelText(esAR["appPropia.claves.campoSecreto"]);
    await u.type(campo, SECRETO);
    await u.click(within(ventana()).getByRole("button", { name: esAR["appPropia.validar"] }));

    expect(campo).toHaveValue(SECRETO);
    expect(within(ventana()).getByRole("alert")).toHaveTextContent(esAR["appPropia.r.app_invalida"]);
  });

  it("desconectar pide confirmación: cancelar no hace nada y confirmar desconecta", async () => {
    const u = usuario();
    pintar({ paso: "G", estado: conectado });

    await u.click(boton(esAR["waba.desconectar.boton"]));
    expect(ventana()).toHaveTextContent(esAR["appPropia.desconectar.confirmar"]);
    await u.click(within(ventana()).getByRole("button", { name: esAR["waba.cancelar"] }));
    sinVentana();
    expect(h.desconectar).not.toHaveBeenCalled();

    await u.click(boton(esAR["waba.desconectar.boton"]));
    await u.click(within(ventana()).getByRole("button", { name: esAR["waba.desconectar.confirmar"] }));

    expect(h.desconectar).toHaveBeenCalledOnce();
    expect(h.refresh).toHaveBeenCalledOnce();
    sinVentana();
  });

  it("Escape cierra la confirmación de desconectar", async () => {
    const u = usuario();
    pintar({ paso: "G", estado: conectado });
    await u.click(boton(esAR["waba.desconectar.boton"]));

    await u.keyboard("{Escape}");

    sinVentana();
    expect(h.desconectar).not.toHaveBeenCalled();
  });

  it.each([
    ["token_vencido", "E6", () => esAR["appPropia.token.nuevoTitulo"]],
    ["secreto_invalido", "E7", () => esAR["appPropia.claves.nuevoTitulo"]],
    ["pago_pendiente", "E8", () => esAR["appPropia.ventana.aviso"]],
    ["coexistencia", "E9", () => esAR["appPropia.ventana.aviso"]],
    ["nombre_rechazado", "E10", () => esAR["appPropia.nombre.titulo"]],
    ["waba_restringida", "E12", () => esAR["appPropia.ventana.aviso"]],
    ["waba_bloqueada", "E12", () => esAR["appPropia.ventana.aviso"]],
  ])("la falla %s abre la ventana %s al entrar", (falla, _ventana, tituloDe) => {
    pintar({ paso: "G", estado: { ...conectado, estado: "falla", falla } });

    expect(within(ventana()).getByRole("heading", { name: tituloDe() })).toBeInTheDocument();
  });

  it("E6: el token nuevo se manda sin ID de cuenta, porque la fila ya lo tiene", async () => {
    const u = usuario();
    pintar({ paso: "G", estado: { ...conectado, estado: "falla", falla: "token_vencido" } });

    await u.type(within(ventana()).getByLabelText(esAR["appPropia.token.campo"]), TOKEN);
    await u.click(within(ventana()).getByRole("button", { name: esAR["appPropia.validar"] }));

    expect(h.token).toHaveBeenCalledWith({ token: TOKEN, wabaId: "", phoneNumberId: undefined });
  });

  it("E8: el aviso de pago lleva al gestor de WhatsApp en una pestaña nueva", () => {
    pintar({ paso: "G", estado: { ...conectado, estado: "falla", falla: "pago_pendiente" } });

    const enlace = within(ventana()).getByRole("link", { name: esAR["waba.estado.pagoEnlace"] });
    expect(enlace).toHaveAttribute("href", WHATSAPP_MANAGER);
    expect(enlace).toHaveAttribute("target", "_blank");
    expect(enlace.getAttribute("rel")).toMatch(/noopener/);
  });

  it("E9: fuera del paso 3 la ventana de coexistencia ofrece reintentar", async () => {
    const u = usuario();
    pintar({ paso: "G", estado: { ...conectado, estado: "falla", falla: "coexistencia" } });

    await u.click(within(ventana()).getByRole("button", { name: esAR["waba.reintentar"] }));

    expect(h.reintentar).toHaveBeenCalledOnce();
  });

  it("una falla sin ventana propia muestra su cartel y «Reintentar»", async () => {
    const u = usuario();
    pintar({ paso: "G", estado: { ...conectado, estado: "falla", falla: "registro" } });
    sinVentana();
    expect(screen.getByRole("alert")).toHaveTextContent(esAR["waba.r.registro"]);

    await u.click(boton(esAR["waba.reintentar"]));

    expect(h.reintentar).toHaveBeenCalledOnce();
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it("una falla con ventana propia ofrece «Seguir donde quedé» para volver a abrirla", async () => {
    const u = usuario();
    pintar({ paso: "G", estado: { ...conectado, estado: "falla", falla: "token_vencido" } });
    await u.click(within(ventana()).getByRole("button", { name: esAR["waba.cancelar"] }));
    sinVentana();

    await u.click(boton(esAR["waba.seguirDonde"]));

    expect(within(ventana()).getByRole("heading", { name: esAR["appPropia.token.nuevoTitulo"] })).toBeInTheDocument();
  });

  it("el cartel de la falla del secreto reemplaza el App ID de la fila", () => {
    pintar({ paso: "G", estado: { ...conectado, estado: "falla", falla: "token_de_otra_app" } });

    expect(screen.getByRole("alert")).toHaveTextContent(esAR["waba.r.meta"]);
  });
});

/* ── R18: la ayuda humana en las ventanas de falla ───────────────────────── */

describe("la ayuda humana en las ventanas de falla", () => {
  const FALLA = {
    ...estadoDe("G", { estado: "falla", appId: APP_ID, numero: NUMERO, nombreEstado: "APPROVED" }),
  };

  const conAyuda = (extra: Partial<AppPropiaPanelProps>) => pintar({ ayuda: AYUDA, ...extra });

  function ayudaVisible() {
    const dialogo = ventana();
    expect(within(dialogo).getByText(esAR["appPropia.ayuda.videollamada"])).toBeInTheDocument();
    expect(within(dialogo).getByText(esAR["appPropia.ayuda.mail"].replace("{mail}", CORREO))).toBeInTheDocument();
    expect(within(dialogo).getByRole("button", { name: `Copiar: ${CORREO}` })).toBeInTheDocument();
    expect(within(dialogo).getByRole("link", { name: esAR["appPropia.ayuda.escribir"] })).toHaveAttribute("href", AYUDA);
  }

  it.each([
    ["E6", "token_vencido"],
    ["E7", "secreto_invalido"],
    ["E8", "pago_pendiente"],
    ["E9", "coexistencia"],
    ["E10", "nombre_rechazado"],
    ["E12", "waba_bloqueada"],
  ])("%s (%s): la ventana lleva el mail, Copiar y el enlace para escribir", (_ventana, falla) => {
    conAyuda({ paso: "G", estado: { ...FALLA, falla } });

    ayudaVisible();
  });

  it("E6: copiar el mail desde la ventana lo manda al portapapeles", async () => {
    const u = usuario();
    conAyuda({ paso: "G", estado: { ...FALLA, falla: "token_vencido" } });

    await u.click(within(ventana()).getByRole("button", { name: `Copiar: ${CORREO}` }));

    expect(h.copiar).toHaveBeenCalledWith(CORREO);
  });

  async function validarConResultado(resultado: object) {
    const u = usuario();
    conAyuda({ paso: "P2", estado: estadoDe("P2", { appId: APP_ID, numero: NUMERO }) });
    await u.click(boton(esAR["appPropia.seguir"]));
    h.token.mockResolvedValue(resultado);
    await u.type(screen.getByLabelText(esAR["appPropia.token.campo"]), ` ${TOKEN} `);
    await u.type(screen.getByLabelText(esAR["appPropia.token.wabaCampo"]), ` ${WABA} `);
    await u.click(boton(esAR["appPropia.validar"]));
    return u;
  }

  it("E5: si Meta informó otro número la ventana también lleva la ayuda", async () => {
    await validarConResultado(ok("numero_distinto", { numeroMeta: "+54 9 11 7777-7777" }));

    ayudaVisible();
  });

  it("E11: el aviso de «esperar» también lleva la ayuda", async () => {
    await validarConResultado(ok("esperar"));

    ayudaVisible();
  });

  it("sin dirección de ayuda, ninguna ventana de falla la muestra", () => {
    pintar({ paso: "G", estado: { ...FALLA, falla: "pago_pendiente" }, ayuda: null });

    const dialogo = ventana();
    expect(within(dialogo).queryByText(esAR["appPropia.ayuda.videollamada"])).not.toBeInTheDocument();
    expect(within(dialogo).queryByRole("link", { name: esAR["appPropia.ayuda.escribir"] })).not.toBeInTheDocument();
  });
});

/* ── seguir ───────────────────────────────────────────────────────────────── */

describe("seguir: una conexión a medias", () => {
  const aMedias = estadoDe("seguir", { estado: "armando", appId: APP_ID });

  it("cuenta que quedó a medias y «Seguir» reintenta en el servidor", async () => {
    const u = usuario();
    pintar({ paso: "seguir", estado: aMedias });
    expect(screen.getByText(esAR["appPropia.reanudar.texto"])).toBeInTheDocument();

    await u.click(boton(esAR["appPropia.seguir"]));

    expect(h.reintentar).toHaveBeenCalledOnce();
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it("lo que pida el servidor al seguir se abre como ventana (código por SMS)", async () => {
    const u = usuario();
    h.reintentar.mockResolvedValue(ok("falta_codigo"));
    pintar({ paso: "seguir", estado: aMedias });

    await u.click(boton(esAR["appPropia.seguir"]));

    expect(within(ventana()).getByRole("heading", { name: esAR["waba.codigo.titulo"] })).toBeInTheDocument();
  });

  it("si hay que esperar muestra el aviso y no pide la página nueva", async () => {
    const u = usuario();
    h.reintentar.mockResolvedValue(ok("esperar"));
    pintar({ paso: "seguir", estado: aMedias });

    await u.click(boton(esAR["appPropia.seguir"]));

    expect(ventana()).toHaveTextContent(esAR["waba.r.esperar"]);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("E3: el paso del código abre la ventana de entrada, sin llamar al servidor", () => {
    pintar({ paso: "E3", estado: estadoDe("E3") });

    expect(within(ventana()).getByRole("heading", { name: esAR["waba.codigo.titulo"] })).toBeInTheDocument();
    expect(h.reintentar).not.toHaveBeenCalled();
  });

  it("E4: el paso del PIN abre la ventana del PIN", () => {
    pintar({ paso: "E4", estado: estadoDe("E4") });

    expect(within(ventana()).getByRole("heading", { name: esAR["waba.pin.titulo"] })).toBeInTheDocument();
  });

  it("E5: el paso del número distinto abre la ventana con el número que informó Meta", () => {
    pintar({ paso: "E5", estado: estadoDe("E5", { numero: "+54 9 11 7777-7777" }), numeroTipeado: TIPEADO });

    expect(ventana()).toHaveTextContent("+54 9 11 7777-7777");
    expect(ventana()).toHaveTextContent(TIPEADO);
  });

  it("cerrar una de esas ventanas deja la pantalla de «Seguir»", async () => {
    const u = usuario();
    pintar({ paso: "E3", estado: estadoDe("E3") });

    await u.click(within(ventana()).getByRole("button", { name: esAR["waba.cancelar"] }));

    sinVentana();
    expect(boton(esAR["appPropia.seguir"])).toBeInTheDocument();
  });
});

/* ── lo común a todas las pantallas ───────────────────────────────────────── */

describe("lo común a todas las pantallas", () => {
  const PANTALLAS: [string, Partial<AppPropiaPanelProps>][] = [
    ["P0", { paso: "P0" }],
    ["P1", { paso: "P1", estado: estadoDe("P1") }],
    ["P1B", { paso: "P1B", legales: LEGALES }],
    ["E14", { paso: "E14", webhook: WEBHOOK }],
    ["P2", { paso: "P2", estado: estadoDe("P2", { numero: NUMERO }) }],
    ["P4", { paso: "P4", estado: estadoDe("P4", { numero: NUMERO }) }],
    ["G", { paso: "G", estado: estadoDe("G", { estado: "conectada", numero: NUMERO, appId: APP_ID }) }],
    ["seguir", { paso: "seguir", estado: estadoDe("seguir") }],
  ];

  it.each(PANTALLAS)("%s: todo enlace que sale a otro sitio abre pestaña nueva sin pasar de dónde viene", (_p, extra) => {
    pintar(extra);

    for (const enlace of document.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')) {
      expect(enlace.getAttribute("rel")).toMatch(/noopener/);
      expect(enlace.getAttribute("rel")).toMatch(/noreferrer/);
    }
  });

  it.each(PANTALLAS.filter(([p]) => p !== "G"))("%s: «Lo sigo después» sale al resto del producto con un enlace común", (_p, extra) => {
    pintar(extra);

    const enlace = screen.getByRole("link", { name: esAR["appPropia.despues"] });
    expect(enlace).toHaveAttribute("href", SIGUE_EN);
    expect(enlace).not.toHaveAttribute("data-next-link");
    expect(screen.getByText(esAR["appPropia.despuesAviso"])).toBeInTheDocument();
  });

  it("cada pantalla con ayuda muestra el mail a la vista, para copiar, y el enlace para escribir", async () => {
    const u = usuario();
    pintar({ paso: "P1", estado: estadoDe("P1"), ayuda: AYUDA });

    expect(screen.getByText(esAR["appPropia.ayuda.mail"].replace("{mail}", CORREO))).toBeInTheDocument();
    expect(screen.getByText(esAR["appPropia.ayuda.videollamada"])).toBeInTheDocument();
    expect(screen.getByRole("link", { name: esAR["appPropia.ayuda.escribir"] })).toHaveAttribute("href", AYUDA);

    await u.click(screen.getByRole("button", { name: `Copiar: ${CORREO}` }));
    expect(h.copiar).toHaveBeenCalledWith(CORREO);
  });

  it("sin dirección de ayuda no muestra nada de ayuda", () => {
    pintar({ paso: "P1", estado: estadoDe("P1"), ayuda: null });

    expect(screen.queryByText(esAR["appPropia.ayuda.videollamada"])).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: esAR["appPropia.ayuda.escribir"] })).not.toBeInTheDocument();
  });

  it("en la pantalla de conectado la ayuda es un solo enlace", () => {
    pintar({ paso: "G", estado: estadoDe("G", { estado: "conectada", numero: NUMERO }), ayuda: AYUDA });

    expect(screen.getByRole("link", { name: esAR["waba.ayuda"] })).toHaveAttribute("href", AYUDA);
  });

  it("si el servidor cambia de paso, el panel arranca de cero con la pantalla nueva", async () => {
    const u = usuario();
    const props: AppPropiaPanelProps = {
      paso: "P1",
      estado: estadoDe("P1"),
      numeroTipeado: TIPEADO,
      empresa: "Aseguradora Sur",
      locale: "es-AR",
      textos: textosDePagina("es-AR"),
      ayuda: null,
    };
    const { rerender } = render(<AppPropiaPanel {...props} />);
    await u.type(screen.getByLabelText(esAR["appPropia.claves.campoApp"]), APP_ID);

    rerender(<AppPropiaPanel {...props} estado={estadoDe("P1", { estado: "armando" })} />);
    expect(screen.getByLabelText(esAR["appPropia.claves.campoApp"])).toHaveValue("");

    rerender(<AppPropiaPanel {...props} paso="P2" estado={estadoDe("P2")} />);
    expect(titulo(esAR["appPropia.cuenta.titulo"])).toBeInTheDocument();
    expect(screen.queryByLabelText(esAR["appPropia.claves.campoApp"])).not.toBeInTheDocument();
  });

  it("con el mismo paso y el mismo estado conserva lo escrito", async () => {
    const u = usuario();
    const props: AppPropiaPanelProps = {
      paso: "P1",
      estado: estadoDe("P1"),
      numeroTipeado: TIPEADO,
      empresa: "Aseguradora Sur",
      locale: "es-AR",
      textos: textosDePagina("es-AR"),
      ayuda: null,
    };
    const { rerender } = render(<AppPropiaPanel {...props} />);
    await u.type(screen.getByLabelText(esAR["appPropia.claves.campoApp"]), APP_ID);

    rerender(<AppPropiaPanel {...props} ayuda={AYUDA} />);

    expect(screen.getByLabelText(esAR["appPropia.claves.campoApp"])).toHaveValue(APP_ID);
  });

  it("en inglés usa los textos en inglés", () => {
    pintar({ paso: "P0", locale: "en-US" });

    expect(screen.queryByText(esAR["appPropia.antes.titulo"])).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start/ })).toBeInTheDocument();
  });

  it("ningún secreto escrito aparece en el HTML de la pantalla mientras se escribe", async () => {
    const u = usuario();
    const { container } = pintar({ paso: "P1", estado: estadoDe("P1") });

    await u.type(screen.getByLabelText(esAR["appPropia.claves.campoSecreto"]), SECRETO);

    expect(container.querySelector('input[type="password"]')).toHaveValue(SECRETO);
    expect(container.textContent).not.toContain(SECRETO);
  });
});

describe("empezar de nuevo mientras la app se arma", () => {
  const armando = (paso: PasoDelAsistente, extra: Partial<EstadoDeApp> = {}) => estadoDe(paso, { estado: "armando", ...extra });
  const PASOS_DE_ARMADO: [string, Partial<AppPropiaPanelProps>][] = [
    ["P1", { paso: "P1", estado: armando("P1") }],
    ["P1B", { paso: "P1B", estado: armando("P1B", { appId: APP_ID }), legales: LEGALES }],
    ["E14", { paso: "E14", estado: armando("E14", { appId: APP_ID }), webhook: WEBHOOK }],
    ["P2", { paso: "P2", estado: armando("P2", { appId: APP_ID, webhookVerificado: true }) }],
  ];
  const abrirLaConfirmacion = (u: ReturnType<typeof usuario>) => u.click(boton(esAR["appPropia.cancelar.boton"]));

  it.each(PASOS_DE_ARMADO)("%s: ofrece «Cancelar y empezar de nuevo»", (_p, extra) => {
    pintar(extra);

    expect(boton(esAR["appPropia.cancelar.boton"])).toBeInTheDocument();
  });

  it.each([
    ["antes de empezar (sin fila)", { paso: "P0" as const, estado: null }],
    ["con la app ya vinculada", { paso: "seguir" as const, estado: estadoDe("seguir", { estado: "vinculada", appId: APP_ID }) }],
    ["probando", { paso: "P4" as const, estado: estadoDe("P4", { estado: "suscripta", appId: APP_ID, numero: NUMERO }) }],
    ["conectado", { paso: "G" as const, estado: estadoDe("G", { estado: "conectada", appId: APP_ID, numero: NUMERO }) }],
  ])("%s: no lo ofrece, porque ahí salir es desconectar y bajar el número", (_nombre, extra) => {
    pintar(extra);

    expect(screen.queryByRole("button", { name: esAR["appPropia.cancelar.boton"] })).not.toBeInTheDocument();
  });

  it("pide confirmación: «No, sigo con esta» y Escape no cancelan nada", async () => {
    const u = usuario();
    pintar(PASOS_DE_ARMADO[0][1]);

    await abrirLaConfirmacion(u);
    expect(ventana()).toHaveTextContent(esAR["appPropia.cancelar.texto"]);
    await u.click(within(ventana()).getByRole("button", { name: esAR["appPropia.cancelar.volver"] }));
    sinVentana();

    await abrirLaConfirmacion(u);
    await u.keyboard("{Escape}");
    sinVentana();

    expect(h.cancelarApp).not.toHaveBeenCalled();
    expect(h.desconectar).not.toHaveBeenCalled();
  });

  it("confirmar cancela en el servidor, cierra la ventana y pide la página nueva", async () => {
    const u = usuario();
    pintar(PASOS_DE_ARMADO[0][1]);

    await abrirLaConfirmacion(u);
    await u.click(within(ventana()).getByRole("button", { name: esAR["appPropia.cancelar.confirmar"] }));

    expect(h.cancelarApp).toHaveBeenCalledOnce();
    expect(h.desconectar).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledOnce();
    sinVentana();
  });

  it("si la fila ya se movió («transicion») también se vuelve a leer la página, sin cartel", async () => {
    const u = usuario();
    h.cancelarApp.mockResolvedValue(ok("transicion"));
    pintar(PASOS_DE_ARMADO[0][1]);

    await abrirLaConfirmacion(u);
    await u.click(within(ventana()).getByRole("button", { name: esAR["appPropia.cancelar.confirmar"] }));

    expect(h.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("si Meta o la base fallan avisa en la pantalla y no pide la página nueva", async () => {
    const u = usuario();
    h.cancelarApp.mockResolvedValue(ok("meta"));
    pintar(PASOS_DE_ARMADO[0][1]);

    await abrirLaConfirmacion(u);
    await u.click(within(ventana()).getByRole("button", { name: esAR["appPropia.cancelar.confirmar"] }));

    expect(screen.getByRole("alert")).toHaveTextContent(esAR["waba.r.meta"]);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("los textos de la confirmación están en inglés con el idioma en-US", async () => {
    const u = usuario();
    pintar({ ...PASOS_DE_ARMADO[0][1], locale: "en-US" });

    await u.click(boton(enUS["appPropia.cancelar.boton"]));

    expect(ventana()).toHaveTextContent(enUS["appPropia.cancelar.texto"]);
  });
});
