/**
 * El panel de /conectar-whatsapp (`WabaPropiaPanel`): la lista de antes de empezar, el
 * popup de Meta y lo que sigue hasta «conectado».
 *
 * Las acciones del servidor y la carga del SDK están simuladas. `abrirRegistro` es el
 * de verdad y habla con un `FB` falso y con `message` reales de la ventana: así se
 * prueba el orden en que llegan el código y el evento, y a qué origen se le hace caso.
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  iniciar: vi.fn(),
  conectar: vi.fn(),
  aceptar: vi.fn(),
  codigo: vi.fn(),
  pin: vi.fn(),
  reintentar: vi.fn(),
  cancelacion: vi.fn(),
  desconectar: vi.fn(),
  refresh: vi.fn(),
  cargar: vi.fn(),
  login: vi.fn(),
  init: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
// Un <Link> deja una marca: así se ve que los enlaces de salida NO navegan del lado del cliente.
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return { default: (p: Record<string, unknown>) => createElement("a", { "data-next-link": "", ...p }) };
});
vi.mock("@/app/conectar-whatsapp/actions", () => ({
  iniciarWabaPropia: h.iniciar,
  conectarWabaPropia: h.conectar,
  aceptarNumeroDeMeta: h.aceptar,
  codigoDeWabaPropia: h.codigo,
  pinDeWabaPropia: h.pin,
  reintentarWabaPropia: h.reintentar,
  cancelacionDeWabaPropia: h.cancelacion,
  desconectarWabaPropia: h.desconectar,
}));
vi.mock("@/app/conectar-whatsapp/meta-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/conectar-whatsapp/meta-sdk")>()),
  cargarSdk: h.cargar,
}));

import { WabaPropiaPanel, type WabaPropiaPanelProps } from "@/app/conectar-whatsapp/WabaPropiaPanel";
import { vistaInicial, type EstadoDeVista } from "@/app/conectar-whatsapp/vista";
import { textosDePagina } from "@/lib/i18n";
import { CATEGORIAS_DE_PERFIL } from "@/lib/whatsapp-categorias";

const WWW = "https://www.facebook.com";
const WABA = "123456789012345";
const NUMERO = "234567890123456";
const NEGOCIO = "345678901234567";
const TIPEADO = "+54 9 11 0000 0000";
const DE_META = "+54 9 11 5555 0000";

const inicio: EstadoDeVista = { vista: "inicio", aviso: null, paso: null, numeroMeta: null };
const enVista = (extra: Partial<EstadoDeVista>): EstadoDeVista => ({ ...inicio, ...extra });

const ok = (resultado: string, extra: object = {}) => ({ resultado, ...extra });
const LISTO = ok("listo", { inicio: "fake-inicio-1", appId: "fake-app-id", configId: "fake-config-id", version: "v23.0", setup: { business: { name: "Aseguradora Sur" } } });

const fin = (evento = "FINISH") => ({ type: "WA_EMBEDDED_SIGNUP", event: evento, data: { waba_id: WABA, phone_number_id: NUMERO, business_id: NEGOCIO } });
const cancelo = (paso = "phone_number_verification", codigo?: number) => ({
  type: "WA_EMBEDDED_SIGNUP",
  event: "CANCEL",
  data: { current_step: paso, ...(codigo === undefined ? {} : { error_code: codigo }) },
});

const mandar = (origen: string, datos: unknown) => act(() => void window.dispatchEvent(new MessageEvent("message", { origin: origen, data: datos })));
/** Lo que haría el SDK al terminar el popup: llamar al callback de `FB.login`. */
const responder = (code?: string | null) =>
  act(() => h.login.mock.calls.at(-1)?.[0](code === undefined ? {} : { authResponse: code === null ? null : { code } }));

function pintar(extra: Partial<WabaPropiaPanelProps> = {}) {
  return render(
    <WabaPropiaPanel
      locale="es-AR"
      textos={textosDePagina(extra.locale ?? "es-AR")}
      nombre="Aseguradora Sur"
      numeroTipeado={TIPEADO}
      inicial={inicio}
      conectado={{ numero: null, nombre: null, plantilla: false }}
      ayuda={null}
      {...extra}
    />
  );
}

const continuar = () => screen.getByRole("button", { name: "Continuar" });

/** Completa la lista y llega a la vista con el botón de Meta. */
async function hastaElBoton() {
  const u = userEvent.setup();
  pintar();
  await u.click(screen.getByLabelText("Tengo todo"));
  await u.click(continuar());
  await screen.findByRole("button", { name: "Conectar con Facebook" });
  return u;
}

/** Además, abre el popup: queda esperando el código y el evento. */
async function hastaElPopup() {
  const u = await hastaElBoton();
  await u.click(screen.getByRole("button", { name: "Conectar con Facebook" }));
  expect(h.login).toHaveBeenCalledOnce();
  return u;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.iniciar.mockResolvedValue(LISTO);
  h.conectar.mockResolvedValue(ok("conectado"));
  h.aceptar.mockResolvedValue(ok("conectado"));
  h.codigo.mockResolvedValue(ok("conectado"));
  h.pin.mockResolvedValue(ok("conectado"));
  h.reintentar.mockResolvedValue(ok("conectado"));
  h.cancelacion.mockResolvedValue(ok("cancelado"));
  h.desconectar.mockResolvedValue(ok("desconectado"));
  h.cargar.mockResolvedValue({ init: h.init, login: h.login });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("la lista de antes de empezar", () => {
  it("dice qué hace falta, con el número que se tipeó al registrarse", () => {
    pintar();

    expect(screen.getByText(/Vas a conectar el número de tu empresa/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Antes de conectar tu WhatsApp" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByText(new RegExp(`El número ${TIPEADO.replace("+", "\\+")}`))).toBeInTheDocument();
    expect(screen.getByText(/Una cuenta de Facebook/)).toBeInTheDocument();
    expect(screen.getByText(/Poder recibir ahora un SMS/)).toBeInTheDocument();
    expect(screen.getByText(/Más adelante, una forma de pago/)).toBeInTheDocument();
  });

  it("sin número tipeado usa la frase general", () => {
    pintar({ numeroTipeado: null });

    expect(screen.getByText(/El número de tu empresa: en Meta/)).toBeInTheDocument();
  });

  it("precarga el nombre visible con el del espacio", () => {
    pintar();

    expect(screen.getByLabelText("Nombre visible")).toHaveValue("Aseguradora Sur");
  });

  it("recorta a 60 letras el nombre que precarga", () => {
    pintar({ nombre: "N".repeat(90) });

    expect(screen.getByLabelText("Nombre visible")).toHaveValue("N".repeat(60));
  });

  describe("«Continuar» sólo se habilita con la lista confirmada", () => {
    it("empieza apagado", () => {
      pintar();

      expect(continuar()).toBeDisabled();
    });

    it("se prende al marcar «Tengo todo» y se apaga al desmarcar", async () => {
      const u = userEvent.setup();
      pintar();

      await u.click(screen.getByLabelText("Tengo todo"));
      expect(continuar()).toBeEnabled();
      await u.click(screen.getByLabelText("Tengo todo"));
      expect(continuar()).toBeDisabled();
    });

    it("sin nombre visible no se habilita", async () => {
      const u = userEvent.setup();
      pintar();
      await u.click(screen.getByLabelText("Tengo todo"));

      await u.clear(screen.getByLabelText("Nombre visible"));
      expect(continuar()).toBeDisabled();

      await u.type(screen.getByLabelText("Nombre visible"), "   ");
      expect(continuar()).toBeDisabled();
    });

    it.each(["http://sitio.example.com", "sitio.example.com", "ftp://sitio.example.com", "https://"])("el sitio %j no se acepta", async (web) => {
      const u = userEvent.setup();
      pintar();
      await u.click(screen.getByLabelText("Tengo todo"));

      await u.type(screen.getByLabelText("Sitio web (opcional)"), web);

      expect(continuar()).toBeDisabled();
      expect(screen.getByLabelText("Sitio web (opcional)")).toHaveAttribute("aria-invalid", "true");
    });

    it("el sitio es opcional, y con https:// se acepta", async () => {
      const u = userEvent.setup();
      pintar();
      await u.click(screen.getByLabelText("Tengo todo"));
      expect(continuar()).toBeEnabled();

      await u.type(screen.getByLabelText("Sitio web (opcional)"), "https://sitio.example.com");

      expect(continuar()).toBeEnabled();
      expect(screen.getByLabelText("Sitio web (opcional)")).toHaveAttribute("aria-invalid", "false");
    });

    it("Enter en el formulario sin la lista confirmada no pide nada al servidor", () => {
      pintar();

      fireEvent.submit(continuar().closest("form") as HTMLFormElement);

      expect(h.iniciar).not.toHaveBeenCalled();
      expect(h.cargar).not.toHaveBeenCalled();
    });
  });

  it("no habla con el servidor ni con Meta antes de «Continuar»", async () => {
    const u = userEvent.setup();
    pintar();
    await u.click(screen.getByLabelText("Tengo todo"));

    expect(h.iniciar).not.toHaveBeenCalled();
    expect(h.cargar).not.toHaveBeenCalled();
    expect(h.login).not.toHaveBeenCalled();
  });

  it("«Continuar» pide el inicio con el nombre y el sitio recortados", async () => {
    const u = userEvent.setup();
    pintar();
    await u.click(screen.getByLabelText("Tengo todo"));
    await u.clear(screen.getByLabelText("Nombre visible"));
    await u.type(screen.getByLabelText("Nombre visible"), "  Sur Seguros  ");
    await u.type(screen.getByLabelText("Sitio web (opcional)"), " https://sitio.example.com ");
    await u.click(continuar());

    await screen.findByRole("button", { name: "Conectar con Facebook" });
    expect(h.iniciar).toHaveBeenCalledWith({ nombre: "Sur Seguros", web: "https://sitio.example.com", categoria: "FINANCE" });
  });

  it("sin sitio manda el sitio sin definir", async () => {
    await hastaElBoton();

    expect(h.iniciar).toHaveBeenCalledWith({ nombre: "Aseguradora Sur", web: undefined, categoria: "FINANCE" });
  });

  describe("el rubro del perfil", () => {
    const selector = (etiqueta = "Rubro de tu empresa") => screen.getByLabelText(etiqueta) as HTMLSelectElement;

    it("ofrece los rubros de Meta, sin los que Meta no ofrece, y sale elegido «Finanzas y seguros»", () => {
      pintar();

      const valores = Array.from(selector().options).map((o) => o.value);
      expect([...valores].sort()).toEqual([...CATEGORIAS_DE_PERFIL].sort());
      expect(valores).not.toContain("UNDEFINED");
      expect(valores).not.toContain("NOT_A_BIZ");
      expect(selector().value).toBe("FINANCE");
      expect(within(selector()).getByRole("option", { name: "Finanzas y seguros" })).toBeInTheDocument();
    });

    it("las etiquetas siguen el idioma y van en orden alfabético de ese idioma", () => {
      pintar({ locale: "en-US" });

      const ingles = selector("Your business category");
      const etiquetas = Array.from(ingles.options).map((o) => o.textContent ?? "");
      expect(etiquetas).toEqual([...etiquetas].sort((a, b) => a.localeCompare(b, "en-US")));
      expect(within(ingles).getByRole("option", { name: "Finance and insurance" })).toHaveValue("FINANCE");
      expect(within(ingles).getByRole("option", { name: "Other" })).toHaveValue("OTHER");
    });

    it("explica que Meta lo muestra precargado y que se puede cambiar ahí", () => {
      pintar();

      expect(selector()).toHaveAccessibleDescription(/ya elegido en la ventana de Meta y lo podés cambiar ahí también/);
    });

    it("el rubro que elige la persona es el que se manda al servidor", async () => {
      const u = userEvent.setup();
      pintar();
      await u.selectOptions(selector(), "Salud");
      await u.click(screen.getByLabelText("Tengo todo"));
      await u.click(continuar());

      await screen.findByRole("button", { name: "Conectar con Facebook" });
      expect(h.iniciar).toHaveBeenCalledWith({ nombre: "Aseguradora Sur", web: undefined, categoria: "HEALTH" });
    });

    it("elegir otro rubro no habilita «Continuar» ni habla con el servidor", async () => {
      const u = userEvent.setup();
      pintar();

      await u.selectOptions(selector(), "Otro");

      expect(selector().value).toBe("OTHER");
      expect(continuar()).toBeDisabled();
      expect(h.iniciar).not.toHaveBeenCalled();
    });

    it("con el inicio vencido, «Reintentar» pide uno nuevo con el mismo rubro", async () => {
      const u = userEvent.setup();
      pintar();
      await u.selectOptions(selector(), "Educación");
      await u.click(screen.getByLabelText("Tengo todo"));
      await u.click(continuar());
      await u.click(await screen.findByRole("button", { name: "Conectar con Facebook" }));
      await mandar(WWW, cancelo("permissions"));
      const dialogo = await screen.findByRole("dialog");
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 9 * 60_000);

      await u.click(within(dialogo).getByRole("button", { name: "Reintentar" }));

      await screen.findByRole("button", { name: "Conectar con Facebook" });
      expect(h.iniciar).toHaveBeenCalledTimes(2);
      expect(h.iniciar).toHaveBeenLastCalledWith({ nombre: "Aseguradora Sur", web: undefined, categoria: "EDU" });
    });
  });

  it("deja un camino a seguir por mail, y otro a pedir ayuda si hay dirección", () => {
    pintar({ ayuda: "mailto:operador@example.com?subject=Ayuda" });

    const seguir = screen.getByRole("link", { name: "Seguir por mail por ahora" });
    expect(seguir).toHaveAttribute("href", "/configuracion?primeros=1");
    // Salir de esta página con carga entera: con <Link> /configuracion se pintaría con el CSP de acá.
    expect(seguir).not.toHaveAttribute("data-next-link");
    expect(screen.getByRole("link", { name: "¿Necesitás ayuda? Escribinos" })).toHaveAttribute("href", "mailto:operador@example.com?subject=Ayuda");
  });

  it("sin dirección de operador no hay enlace de ayuda", () => {
    pintar({ ayuda: null });

    expect(screen.queryByRole("link", { name: /Necesitás ayuda/ })).toBeNull();
  });

  it("en inglés", () => {
    pintar({ locale: "en-US" });

    expect(screen.getByRole("heading", { name: "Before you connect your WhatsApp" })).toBeInTheDocument();
    expect(screen.getByLabelText("I have everything")).toBeInTheDocument();
  });
});

describe("del inicio al botón de Meta", () => {
  it("carga el SDK en el idioma de la persona, con lo que dio el servidor", async () => {
    await hastaElBoton();

    expect(h.cargar).toHaveBeenCalledWith({ appId: "fake-app-id", version: "v23.0", idioma: "es_LA" });
  });

  it("en inglés carga el SDK en inglés", async () => {
    const u = userEvent.setup();
    pintar({ locale: "en-US" });
    await u.click(screen.getByLabelText("I have everything"));
    await u.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("button", { name: "Connect with Facebook" });

    expect(h.cargar).toHaveBeenCalledWith({ appId: "fake-app-id", version: "v23.0", idioma: "en_US" });
  });

  it("todavía no abre el popup: falta el clic", async () => {
    await hastaElBoton();

    expect(h.login).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Al tocar el botón se abre una ventana de Meta");
  });

  it("el clic abre el popup en el mismo momento, sin esperar nada", async () => {
    await hastaElBoton();

    fireEvent.click(screen.getByRole("button", { name: "Conectar con Facebook" }));

    // Sin `await`: el navegador sólo deja abrir la ventana dentro del gesto.
    expect(h.login).toHaveBeenCalledOnce();
    expect(h.login.mock.calls[0][1]).toEqual({
      config_id: "fake-config-id",
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: { business: { name: "Aseguradora Sur" } } },
    });
  });

  it("mientras el popup está abierto lo dice", async () => {
    await hastaElPopup();

    expect(screen.getByRole("status")).toHaveTextContent("Terminá los pasos en la ventana de Meta");
  });

  it.each([
    ["el servidor dice cupo", ok("cupo"), /no tenemos lugar para conectar más cuentas/],
    ["el servidor dice apagado", ok("apagado"), /no está disponible por ahora/],
    ["el servidor dice esperar", ok("esperar"), /demasiados intentos/],
    ["falta el inicio", ok("listo", { appId: "a", configId: "c", version: "v" }), /Meta no pudo terminar la conexión/],
    ["falta el config_id", ok("listo", { inicio: "i", appId: "a", version: "v" }), /Meta no pudo terminar la conexión/],
  ])("%s: se queda en la lista con el aviso, sin cargar el SDK", async (_caso, respuesta, texto) => {
    h.iniciar.mockResolvedValue(respuesta);
    const u = userEvent.setup();
    pintar();
    await u.click(screen.getByLabelText("Tengo todo"));
    await u.click(continuar());

    expect(await screen.findByRole("alert")).toHaveTextContent(texto);
    expect(h.cargar).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Tengo todo")).toBeInTheDocument();
  });

  it("si la acción revienta, avisa que Meta no pudo y no deja la pantalla colgada", async () => {
    h.iniciar.mockRejectedValue(new Error("boom con datos del cliente"));
    const u = userEvent.setup();
    pintar();
    await u.click(screen.getByLabelText("Tengo todo"));
    await u.click(continuar());

    const aviso = await screen.findByRole("alert");
    expect(aviso).toHaveTextContent("Meta no pudo terminar la conexión");
    expect(document.body).not.toHaveTextContent("datos del cliente");
    expect(continuar()).toBeEnabled();
  });

  describe("el SDK no carga (bloqueador de anuncios, red, tiempo)", () => {
    beforeEach(() => {
      h.cargar.mockRejectedValue(new Error("sdk_timeout"));
    });

    it("avisa del bloqueador y deja reintentar desde la lista", async () => {
      const u = userEvent.setup();
      pintar();
      await u.click(screen.getByLabelText("Tengo todo"));
      await u.click(continuar());

      expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar la ventana de Meta. Puede ser un bloqueador de anuncios o la red.");
      expect(screen.queryByRole("button", { name: "Conectar con Facebook" })).toBeNull();
      expect(continuar()).toBeEnabled();
      expect(h.login).not.toHaveBeenCalled();
    });

    it("el segundo intento vuelve a pedir el inicio y a cargar", async () => {
      const u = userEvent.setup();
      pintar();
      await u.click(screen.getByLabelText("Tengo todo"));
      await u.click(continuar());
      await screen.findByRole("alert");
      h.cargar.mockResolvedValue({ init: h.init, login: h.login });

      await u.click(continuar());

      await screen.findByRole("button", { name: "Conectar con Facebook" });
      expect(h.iniciar).toHaveBeenCalledTimes(2);
      expect(h.cargar).toHaveBeenCalledTimes(2);
    });
  });
});

describe("lo que deja el popup, sin importar el orden", () => {
  it("el evento y después el código: conecta con todo lo que contó el popup", async () => {
    await hastaElPopup();

    await mandar(WWW, JSON.stringify(fin()));
    await responder("fake-code");

    expect(await screen.findByText(/El agente ya atiende por el número/)).toBeInTheDocument();
    expect(h.conectar).toHaveBeenCalledOnce();
    expect(h.conectar).toHaveBeenCalledWith({
      inicio: "fake-inicio-1",
      code: "fake-code",
      evento: "FINISH",
      wabaId: WABA,
      phoneNumberId: NUMERO,
    });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("el código y después el evento: da lo mismo", async () => {
    await hastaElPopup();

    await responder("fake-code");
    await mandar(WWW, fin("FINISH_ONLY_WABA"));

    await screen.findByText(/El agente ya atiende por el número/);
    expect(h.conectar).toHaveBeenCalledWith({
      inicio: "fake-inicio-1",
      code: "fake-code",
      evento: "FINISH_ONLY_WABA",
      wabaId: WABA,
      phoneNumberId: NUMERO,
    });
  });

  describe("sin evento a tiempo", () => {
    it("el código solo se manda a los tres segundos: el servidor saca los ids del token", async () => {
      await hastaElPopup();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      await responder("fake-code");
      await act(() => vi.advanceTimersByTimeAsync(2_999));
      expect(h.conectar).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(1));
      vi.useRealTimers();

      await screen.findByText(/El agente ya atiende por el número/);
      expect(h.conectar).toHaveBeenCalledWith({
        inicio: "fake-inicio-1",
        code: "fake-code",
        evento: undefined,
        wabaId: undefined,
        phoneNumberId: undefined,
      });
    });

    it("un evento de un origen que no es de Meta no cuenta: se manda el código solo", async () => {
      await hastaElPopup();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      await mandar("https://evil-facebook.com", fin());
      await mandar("https://www.facebook.com.evil.example.com", fin());
      await responder("fake-code");
      await act(() => vi.advanceTimersByTimeAsync(3_000));
      vi.useRealTimers();

      await screen.findByText(/El agente ya atiende por el número/);
      expect(h.conectar).toHaveBeenCalledWith(expect.objectContaining({ code: "fake-code", evento: undefined, wabaId: undefined, phoneNumberId: undefined }));
    });

    it("una cancelación falsa de otro origen no cierra nada", async () => {
      await hastaElPopup();

      await mandar("https://evil-facebook.com", cancelo());

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(h.cancelacion).not.toHaveBeenCalled();
      expect(screen.getByRole("status")).toHaveTextContent("Terminá los pasos en la ventana de Meta");
    });

    it.each(["{no es json", "null", "[]", "42"])("un message que no sirve (%j) se ignora", async (basura) => {
      await hastaElPopup();

      await mandar(WWW, basura);
      await mandar(WWW, { cualquier: "cosa" });

      expect(screen.getByRole("status")).toHaveTextContent("Terminá los pasos en la ventana de Meta");
      expect(h.conectar).not.toHaveBeenCalled();
    });

    it("el popup se cerró sin código ni evento: una cancelación en «otro» a los tres segundos", async () => {
      await hastaElPopup();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      await responder(null);
      await act(() => vi.advanceTimersByTimeAsync(3_000));
      vi.useRealTimers();

      const dialogo = await screen.findByRole("dialog");
      expect(dialogo).toHaveTextContent("La ventana de Meta se cerró antes de terminar.");
      expect(h.cancelacion).toHaveBeenCalledWith({ paso: "otro", codigo: undefined });
      expect(h.conectar).not.toHaveBeenCalled();
    });
  });
});

describe("si se cancela en el popup", () => {
  it.each([
    ["business_account_selection", "al elegir tu cuenta de empresa de Meta"],
    ["waba_phone_profile_picker", "al elegir tu cuenta de WhatsApp Business y tu número"],
    ["whatsapp_business_profile_setup", "al completar el perfil de WhatsApp Business"],
    ["phone_number_setup", "al cargar tu número"],
    ["phone_number_verification", "al verificar el número con el código"],
    ["permissions", "al dar los permisos"],
  ])("en el paso %s, el diálogo dice dónde fue", async (paso, frase) => {
    await hastaElPopup();

    await mandar(WWW, cancelo(paso, 100));

    const dialogo = await screen.findByRole("dialog");
    expect(dialogo).toHaveAccessibleName("Cerraste la ventana de Meta");
    expect(dialogo).toHaveTextContent(frase);
    expect(h.cancelacion).toHaveBeenCalledWith({ paso, codigo: 100 });
  });

  it("un paso que no está en la lista se cuenta como «otro»", async () => {
    await hastaElPopup();

    await mandar(WWW, cancelo("<script>alert(1)</script>"));

    expect(await screen.findByRole("dialog")).toHaveTextContent("La ventana de Meta se cerró antes de terminar.");
    expect(h.cancelacion).toHaveBeenCalledWith({ paso: "otro", codigo: undefined });
  });

  it("si anotar la cancelación falla, la pantalla igual lo cuenta", async () => {
    h.cancelacion.mockRejectedValue(new Error("boom"));
    await hastaElPopup();

    await mandar(WWW, cancelo("permissions"));

    expect(await screen.findByRole("dialog")).toHaveTextContent("Cerraste la ventana al dar los permisos");
  });

  it("no se conecta nada", async () => {
    await hastaElPopup();

    await mandar(WWW, cancelo());
    await responder(null);

    expect(h.conectar).not.toHaveBeenCalled();
  });

  it("«Reintentar» abre el popup otra vez con el mismo inicio, sin pedir uno nuevo", async () => {
    const u = await hastaElPopup();
    await mandar(WWW, cancelo("permissions"));
    const dialogo = await screen.findByRole("dialog");

    await u.click(within(dialogo).getByRole("button", { name: "Reintentar" }));

    expect(h.login).toHaveBeenCalledTimes(2);
    expect(h.iniciar).toHaveBeenCalledOnce();
  });

  it("pasados los 8 minutos el inicio ya no sirve: «Reintentar» pide uno nuevo", async () => {
    const u = await hastaElPopup();
    await mandar(WWW, cancelo("permissions"));
    const dialogo = await screen.findByRole("dialog");
    const ahora = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(ahora + 9 * 60_000);

    await u.click(within(dialogo).getByRole("button", { name: "Reintentar" }));

    await screen.findByRole("button", { name: "Conectar con Facebook" });
    expect(h.iniciar).toHaveBeenCalledTimes(2);
    expect(h.login).toHaveBeenCalledOnce();
  });

  it("ofrece seguir por mail", async () => {
    await hastaElPopup();
    await mandar(WWW, cancelo());

    const seguir = within(await screen.findByRole("dialog")).getByRole("link", { name: "Seguir por mail por ahora" });
    expect(seguir).toHaveAttribute("href", "/configuracion?primeros=1");
    expect(seguir).not.toHaveAttribute("data-next-link");
  });

  it("Escape cierra el diálogo y deja «Seguir donde quedé»", async () => {
    const u = await hastaElPopup();
    await mandar(WWW, cancelo());
    await screen.findByRole("dialog");

    await u.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Falta un paso para terminar de conectar tu WhatsApp.");
    await u.click(screen.getByRole("button", { name: "Seguir donde quedé" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("si Meta informa otro número", () => {
  beforeEach(() => {
    h.conectar.mockResolvedValue(ok("numero_distinto", { numeroMeta: DE_META }));
  });

  async function hastaElDialogo() {
    const u = await hastaElPopup();
    await mandar(WWW, fin());
    await responder("fake-code");
    const dialogo = await screen.findByRole("dialog");
    return { u, dialogo };
  }

  it("pregunta si es el número, con el de Meta y el que se tipeó", async () => {
    const { dialogo } = await hastaElDialogo();

    expect(dialogo).toHaveAccessibleName("¿Es este tu número?");
    expect(dialogo).toHaveTextContent(`En Meta elegiste ${DE_META}`);
    expect(dialogo).toHaveTextContent(`(${TIPEADO})`);
  });

  it("«Usar este número» lo acepta y conecta", async () => {
    const { u, dialogo } = await hastaElDialogo();

    await u.click(within(dialogo).getByRole("button", { name: "Usar este número" }));

    expect(await screen.findByText(/El agente ya atiende por el número/)).toBeInTheDocument();
    expect(h.aceptar).toHaveBeenCalledOnce();
    expect(h.refresh).toHaveBeenCalled();
  });

  it("«Elegir otro» vuelve a empezar con un inicio nuevo", async () => {
    const { u, dialogo } = await hastaElDialogo();

    await u.click(within(dialogo).getByRole("button", { name: "Elegir otro" }));

    await screen.findByRole("button", { name: "Conectar con Facebook" });
    expect(h.iniciar).toHaveBeenCalledTimes(2);
    expect(h.aceptar).not.toHaveBeenCalled();
  });

  it("el texto se arma desde el diccionario: lo que mande el servidor sólo entra como número", async () => {
    h.conectar.mockResolvedValue(ok("numero_distinto", { numeroMeta: "<img src=x onerror=alert(1)>" }));
    await hastaElPopup();
    await mandar(WWW, fin());
    await responder("fake-code");

    const dialogo = await screen.findByRole("dialog");
    expect(dialogo.querySelector("img")).toBeNull();
  });
});

describe("el código y el PIN", () => {
  async function hasta(resultado: string) {
    h.conectar.mockResolvedValue(ok(resultado));
    const u = await hastaElPopup();
    await mandar(WWW, fin());
    await responder("fake-code");
    const dialogo = await screen.findByRole("dialog");
    return { u, dialogo };
  }

  describe("verificar el número", () => {
    it("pide el código con foco en el campo", async () => {
      const { dialogo } = await hasta("falta_codigo");

      expect(dialogo).toHaveAccessibleName("Verificá tu número");
      expect(within(dialogo).getByLabelText("Código de 6 dígitos")).toHaveFocus();
    });

    it("«Mandar SMS» y «Llamarme» piden cada uno lo suyo", async () => {
      const { u, dialogo } = await hasta("falta_codigo");
      h.codigo.mockResolvedValue(ok("codigo_enviado"));

      await u.click(within(dialogo).getByRole("button", { name: "Mandar SMS" }));
      await u.click(within(dialogo).getByRole("button", { name: "Llamarme" }));

      expect(h.codigo).toHaveBeenNthCalledWith(1, { accion: "SMS" });
      expect(h.codigo).toHaveBeenNthCalledWith(2, { accion: "VOICE" });
    });

    it("«código enviado» se avisa como estado, no como alerta", async () => {
      const { u, dialogo } = await hasta("falta_codigo");
      h.codigo.mockResolvedValue(ok("codigo_enviado"));

      await u.click(within(dialogo).getByRole("button", { name: "Mandar SMS" }));

      expect(await within(dialogo).findByRole("status")).toHaveTextContent("Te mandamos el código. Escribilo abajo.");
    });

    it("«Verificar» sólo se habilita con seis dígitos, y acepta el espacio del SMS", async () => {
      const { u, dialogo } = await hasta("falta_codigo");
      const campo = within(dialogo).getByLabelText("Código de 6 dígitos");
      const verificar = within(dialogo).getByRole("button", { name: "Verificar" });
      expect(verificar).toBeDisabled();

      await u.type(campo, "12345");
      expect(verificar).toBeDisabled();
      await u.type(campo, "a");
      expect(verificar).toBeDisabled();
      await u.clear(campo);
      await u.type(campo, "123 456");
      expect(verificar).toBeEnabled();

      await u.click(verificar);

      expect(h.codigo).toHaveBeenCalledWith({ accion: "verificar", codigo: "123456" });
    });

    it("Enter con un código incompleto no manda nada", async () => {
      const { u, dialogo } = await hasta("falta_codigo");

      await u.type(within(dialogo).getByLabelText("Código de 6 dígitos"), "123{Enter}");

      expect(h.codigo).not.toHaveBeenCalled();
    });

    it("un código incorrecto avisa en el mismo diálogo y deja probar de nuevo", async () => {
      const { u, dialogo } = await hasta("falta_codigo");
      h.codigo.mockResolvedValue(ok("codigo_incorrecto"));

      await u.type(within(dialogo).getByLabelText("Código de 6 dígitos"), "000000");
      await u.click(within(dialogo).getByRole("button", { name: "Verificar" }));

      expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("Ese código no es el correcto");
    });

    it("con el código bueno termina conectado", async () => {
      const { u, dialogo } = await hasta("falta_codigo");

      await u.type(within(dialogo).getByLabelText("Código de 6 dígitos"), "123456");
      await u.click(within(dialogo).getByRole("button", { name: "Verificar" }));

      expect(await screen.findByText(/El agente ya atiende por el número/)).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("«Cancelar» cierra el diálogo sin mandar nada", async () => {
      const { u, dialogo } = await hasta("falta_codigo");

      await u.click(within(dialogo).getByRole("button", { name: "Cancelar" }));

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(h.codigo).not.toHaveBeenCalled();
    });
  });

  describe("el PIN de dos pasos", () => {
    it("el campo es de contraseña y no se autocompleta", async () => {
      const { dialogo } = await hasta("falta_pin");

      const campo = within(dialogo).getByLabelText("PIN de 6 dígitos");
      expect(dialogo).toHaveAccessibleName("PIN de verificación en dos pasos");
      expect(campo).toHaveAttribute("type", "password");
      expect(campo).toHaveAttribute("autocomplete", "off");
      expect(campo).toHaveFocus();
    });

    it("«Continuar» sólo se habilita con seis dígitos", async () => {
      const { u, dialogo } = await hasta("falta_pin");
      const enviar = within(dialogo).getByRole("button", { name: "Continuar" });

      await u.type(within(dialogo).getByLabelText("PIN de 6 dígitos"), "12345");
      expect(enviar).toBeDisabled();
      await u.type(within(dialogo).getByLabelText("PIN de 6 dígitos"), "6");
      expect(enviar).toBeEnabled();

      await u.click(enviar);

      expect(h.pin).toHaveBeenCalledWith({ pin: "123456" });
      expect(await screen.findByText(/El agente ya atiende por el número/)).toBeInTheDocument();
    });

    it("un PIN incorrecto avisa y deja probar de nuevo", async () => {
      const { u, dialogo } = await hasta("falta_pin");
      h.pin.mockResolvedValue(ok("pin_incorrecto"));

      await u.type(within(dialogo).getByLabelText("PIN de 6 dígitos"), "000000");
      await u.click(within(dialogo).getByRole("button", { name: "Continuar" }));

      expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("Ese PIN no es el correcto");
    });
  });
});

describe("cuando algo falla después del popup", () => {
  async function conResultado(resultado: string) {
    h.conectar.mockResolvedValue(ok(resultado));
    const u = await hastaElPopup();
    await mandar(WWW, fin());
    await responder("fake-code");
    await screen.findByRole("alert");
    return u;
  }

  it.each([
    ["coexistencia", /Ese número se usa en la app WhatsApp Business/],
    ["sin_numero", /Terminaste en Meta sin elegir un número/],
    ["de_la_plataforma", /Elegiste un número que no es el de tu empresa/],
    ["canje", /Meta no aceptó la autorización/],
    ["token_invalido", /La autorización de Meta no alcanzó/],
  ])("%s: aviso y «Reintentar» pide un inicio nuevo, porque el código ya se gastó", async (resultado, texto) => {
    const u = await conResultado(resultado);
    expect(screen.getByRole("alert")).toHaveTextContent(texto);

    await u.click(screen.getByRole("button", { name: "Reintentar" }));

    // El popup no se abre solo: hace falta un clic nuevo con el inicio nuevo.
    await u.click(await screen.findByRole("button", { name: "Conectar con Facebook" }));
    expect(h.iniciar).toHaveBeenCalledTimes(2);
    expect(h.login).toHaveBeenCalledTimes(2);
  });

  it("vencido: vuelve a la lista del principio con el aviso", async () => {
    await conResultado("vencido");

    expect(screen.getByRole("alert")).toHaveTextContent("Se venció el tiempo para terminar");
    expect(screen.getByLabelText("Tengo todo")).toBeInTheDocument();
  });

  it.each(["meta", "esperar", "suscripcion", "registro", "webhook"])("%s: «Reintentar» sigue desde el servidor, sin abrir el popup", async (resultado) => {
    const u = await conResultado(resultado);
    h.reintentar.mockResolvedValue(ok("conectado"));

    await u.click(screen.getByRole("button", { name: "Reintentar" }));

    expect(await screen.findByText(/El agente ya atiende por el número/)).toBeInTheDocument();
    expect(h.reintentar).toHaveBeenCalledOnce();
    expect(h.login).toHaveBeenCalledOnce();
  });

  it.each(["numero_ocupado", "cupo", "revision", "apagado"])("%s: no hay «Reintentar», se sigue por mail", async (resultado) => {
    await conResultado(resultado);

    expect(screen.queryByRole("button", { name: "Reintentar" })).toBeNull();
    expect(screen.getByRole("link", { name: "Seguir por mail por ahora" })).toBeInTheDocument();
  });

  it("si «Reintentar» tampoco anda, sigue avisando", async () => {
    const u = await conResultado("meta");
    h.reintentar.mockResolvedValue(ok("webhook"));

    await u.click(screen.getByRole("button", { name: "Reintentar" }));

    expect(await screen.findByText(/No pudimos terminar de enlazar tu número con el agente/)).toBeInTheDocument();
  });

  it("si la acción revienta, avisa que Meta no pudo", async () => {
    h.conectar.mockRejectedValue(new Error("boom con datos del cliente"));
    await hastaElPopup();
    await mandar(WWW, fin());
    await responder("fake-code");

    expect(await screen.findByRole("alert")).toHaveTextContent("Meta no pudo terminar la conexión");
    expect(document.body).not.toHaveTextContent("datos del cliente");
  });
});

describe("las vistas con las que arranca la página", () => {
  it("a medias y con token: «Seguir» retoma desde el servidor, sin popup", async () => {
    const u = userEvent.setup();
    pintar({ inicial: enVista({ vista: "continuar" }) });
    expect(screen.getByRole("status")).toHaveTextContent("Falta un paso para terminar de conectar tu WhatsApp.");

    await u.click(screen.getByRole("button", { name: "Seguir" }));

    expect(await screen.findByText(/El agente ya atiende por el número/)).toBeInTheDocument();
    expect(h.reintentar).toHaveBeenCalledOnce();
    expect(h.login).not.toHaveBeenCalled();
  });

  it("sin token: la lista del principio, avisando que venció", () => {
    pintar({ inicial: vistaInicial({ estado: "falta_pin", falla: null, paso: null, numero: null, numeroDistinto: false, numeroMeta: null, conToken: false }) });

    expect(screen.getByRole("alert")).toHaveTextContent("Se venció el tiempo para terminar");
    expect(screen.getByLabelText("Tengo todo")).toBeInTheDocument();
  });

  it("pide el código: abre el diálogo", () => {
    pintar({ inicial: enVista({ vista: "codigo" }) });

    expect(screen.getByRole("dialog")).toHaveAccessibleName("Verificá tu número");
  });

  it("pide el PIN: abre el diálogo", () => {
    pintar({ inicial: enVista({ vista: "pin" }) });

    expect(screen.getByRole("dialog")).toHaveAccessibleName("PIN de verificación en dos pasos");
  });

  it("número distinto: abre el diálogo con los dos números", () => {
    pintar({ inicial: enVista({ vista: "numero_distinto", numeroMeta: DE_META }) });

    expect(screen.getByRole("dialog")).toHaveTextContent(`En Meta elegiste ${DE_META}`);
  });

  it("cancelada: dice en qué paso", () => {
    pintar({ inicial: enVista({ vista: "cancelada", paso: "phone_number_setup" }) });

    expect(screen.getByRole("dialog")).toHaveTextContent("Cerraste la ventana al cargar tu número.");
  });

  it("cancelada sin popup abierto: «Reintentar» empieza de cero", async () => {
    const u = userEvent.setup();
    pintar({ inicial: enVista({ vista: "cancelada", paso: "otro" }) });

    await u.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reintentar" }));

    await screen.findByRole("button", { name: "Conectar con Facebook" });
    expect(h.iniciar).toHaveBeenCalledOnce();
  });

  it("en falla de token vencido: aviso y «Reintentar» vuelve a abrir el popup", async () => {
    const u = userEvent.setup();
    pintar({ inicial: enVista({ vista: "falla", aviso: "token_vencido" }) });
    expect(screen.getByRole("alert")).toHaveTextContent("Meta cerró la autorización de tu cuenta");

    await u.click(screen.getByRole("button", { name: "Reintentar" }));

    await screen.findByRole("button", { name: "Conectar con Facebook" });
    expect(h.iniciar).toHaveBeenCalledOnce();
  });

  it("en falla de nombre rechazado no hay «Reintentar»", () => {
    pintar({ inicial: enVista({ vista: "falla", aviso: "nombre_rechazado" }) });

    expect(screen.getByRole("alert")).toHaveTextContent("Meta no aprobó el nombre visible");
    expect(screen.queryByRole("button", { name: "Reintentar" })).toBeNull();
  });
});

describe("conectado", () => {
  const conectado = { numero: DE_META, nombre: "aprobado" as const, plantilla: true };
  const pintarConectado = (extra: Partial<WabaPropiaPanelProps> = {}) => pintar({ inicial: enVista({ vista: "conectado" }), conectado, ...extra });

  it("dice con qué número atiende el agente y cómo viene todo", () => {
    pintarConectado();

    expect(screen.getByText(`El agente ya atiende por el número ${DE_META}.`)).toBeInTheDocument();
    expect(screen.getByText("Nombre visible: Meta lo aprobó.")).toBeInTheDocument();
    expect(screen.getByText(/Mensaje para retomar una denuncia pasadas 24 horas: enviado a Meta/)).toBeInTheDocument();
  });

  it.each([
    ["revision", /Meta lo está revisando/],
    ["otro", /Meta no lo aprobó/],
    [null, /todavía sin novedades de Meta/],
  ] as const)("el nombre %s", (nombre, texto) => {
    pintarConectado({ conectado: { ...conectado, nombre } });

    expect(screen.getByText(texto)).toBeInTheDocument();
  });

  it("la plantilla sin enviar", () => {
    pintarConectado({ conectado: { ...conectado, plantilla: false } });

    expect(screen.getByText(/todavía no se envió a Meta/)).toBeInTheDocument();
  });

  it("sin número a mano, un guion", () => {
    pintarConectado({ conectado: { ...conectado, numero: null } });

    expect(screen.getByText("El agente ya atiende por el número -.")).toBeInTheDocument();
  });

  it("la forma de pago es sólo un dato: un enlace a WhatsApp Manager que abre aparte", () => {
    pintarConectado();

    const enlace = screen.getByRole("link", { name: "Abrir WhatsApp Manager" });
    expect(enlace).toHaveAttribute("href", "https://business.facebook.com/wa/manage/home/");
    expect(enlace).toHaveAttribute("target", "_blank");
    expect(enlace).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/Por ahora no frena nada/)).toBeInTheDocument();
  });

  it("«Seguir» lleva a los primeros pasos", () => {
    pintarConectado();

    const seguir = screen.getByRole("link", { name: "Seguir" });
    expect(seguir).toHaveAttribute("href", "/configuracion?primeros=1");
    expect(seguir).not.toHaveAttribute("data-next-link");
  });

  it("muestra la ayuda sólo si hay dirección", () => {
    pintarConectado({ ayuda: "mailto:operador@example.com" });

    expect(screen.getByRole("link", { name: "¿Necesitás ayuda? Escribinos" })).toHaveAttribute("href", "mailto:operador@example.com");
  });

  describe("desconectar", () => {
    it("pide confirmación antes de hacer nada", async () => {
      const u = userEvent.setup();
      pintarConectado();

      await u.click(screen.getByRole("button", { name: "Desconectar WhatsApp" }));

      const dialogo = screen.getByRole("dialog");
      expect(dialogo).toHaveAccessibleName("¿Desconectar tu WhatsApp?");
      expect(dialogo).toHaveTextContent("Tu cuenta de Meta no se borra.");
      expect(h.desconectar).not.toHaveBeenCalled();
    });

    it("«Cancelar» y Escape lo cierran sin desconectar", async () => {
      const u = userEvent.setup();
      pintarConectado();

      await u.click(screen.getByRole("button", { name: "Desconectar WhatsApp" }));
      await u.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancelar" }));
      expect(screen.queryByRole("dialog")).toBeNull();

      await u.click(screen.getByRole("button", { name: "Desconectar WhatsApp" }));
      await u.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(h.desconectar).not.toHaveBeenCalled();
    });

    it("«Sí, desconectar» da de baja, refresca la página y vuelve a la lista del principio", async () => {
      const u = userEvent.setup();
      pintarConectado();

      await u.click(screen.getByRole("button", { name: "Desconectar WhatsApp" }));
      await u.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sí, desconectar" }));

      expect(await screen.findByLabelText("Tengo todo")).not.toBeChecked();
      expect(h.desconectar).toHaveBeenCalledOnce();
      expect(h.refresh).toHaveBeenCalledOnce();
      expect(continuar()).toBeDisabled();
    });
  });

  it("en inglés", () => {
    pintarConectado({ locale: "en-US" });

    expect(screen.getByText(`The agent now answers on the number ${DE_META}.`)).toBeInTheDocument();
  });
});

describe("lo que nunca se muestra", () => {
  it("el panel no pone en pantalla nada que haya mandado Meta ni el servidor, sólo claves del diccionario", async () => {
    h.conectar.mockResolvedValue({ resultado: "meta", mensaje: "Error validating access token: EAAG fake-secreto", detalle: { token: "fake-secreto" } });
    await hastaElPopup();
    await mandar(WWW, fin());
    await responder("fake-code");

    await screen.findByRole("alert");
    expect(document.body).not.toHaveTextContent("fake-secreto");
    expect(document.body).not.toHaveTextContent("Error validating");
  });

  it("un resultado que no está en la lista cae en el aviso genérico y no revienta", async () => {
    h.conectar.mockResolvedValue({ resultado: "algo_inventado" });
    await hastaElPopup();
    await mandar(WWW, fin());
    await responder("fake-code");

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
