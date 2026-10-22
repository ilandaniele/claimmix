/**
 * /registro: qué se muestra.
 *
 * Primer paso del alta: sólo la cuenta. «Continuar con Google» está siempre;
 * «Crear cuenta con mi correo» (con el nombre y el correo) sólo si hay remitente del
 * sistema, porque sin él no hay cómo mandar el enlace. La empresa y el WhatsApp
 * se piden en /alta, no acá. El desafío de Turnstile sólo con las dos claves, y
 * dentro de la parte del correo: no frena a Google.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  remitente: vi.fn(),
  locale: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-csp-nonce": "nonce-de-prueba" }),
}));
vi.mock("@/lib/i18n/locale", () => ({ getServerLocale: h.locale }));
vi.mock("@/server/notify/remitente-sistema", () => ({ remitenteDelSistema: h.remitente }));
vi.mock("@/app/registro/actions", () => ({ signUp: vi.fn(), empezarAltaConGoogle: vi.fn() }));

import RegistroPage from "@/app/registro/page";

async function pintar(e?: string | string[]) {
  return render(await RegistroPage({ searchParams: Promise.resolve(e === undefined ? {} : { e }) }));
}

const conRemitente = () => h.remitente.mockReturnValue({ correo: "sistema@example.com" });

// El desafío agrega el script a <head> al montarse: se busca en todo el documento.
const scriptDeTurnstile = () => document.querySelector<HTMLScriptElement>('script[src^="https://challenges.cloudflare.com"]');

const conClaves = () => {
  process.env.TURNSTILE_SITE_KEY = "test-turnstile-site-key";
  process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret-key";
};

// Las banderas que antes cambiaban la ayuda del WhatsApp: ya no hay WhatsApp acá.
const BANDERAS = ["ALTA_NUMERO_AUTOMATICO", "ALTA_WABA_PROPIA", "META_APP_ID", "META_ES_CONFIG_ID", "WHATSAPP_APP_SECRET"];
const sinBanderas = () => BANDERAS.forEach((nombre) => delete process.env[nombre]);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  sinBanderas();
  h.locale.mockResolvedValue("es-AR");
  h.remitente.mockReturnValue(null);
});

afterEach(() => {
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  sinBanderas();
  scriptDeTurnstile()?.remove();
  vi.unstubAllGlobals();
});

describe("/registro: los campos", () => {
  it("sólo la cuenta: nombre, correo y términos obligatorios; Google no pide nada más", async () => {
    conRemitente();
    const { container } = await pintar();

    const nombres = [...container.querySelectorAll("input, select, textarea")].map((campo) => campo.getAttribute("name"));
    expect(nombres.sort()).toEqual(["email", "full_name", "terminos"]);
    expect(screen.getByRole("checkbox")).toBeRequired();
    expect(screen.getByRole("link", { name: "términos de uso" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "política de privacidad" })).toHaveAttribute("href", "/privacy");
  });

  it("no pide la empresa ni el WhatsApp: se piden en /alta", async () => {
    conRemitente();
    const { container } = await pintar();

    expect(container.querySelector('[name="empresa"]')).toBeNull();
    expect(container.querySelector('[name="whatsapp"]')).toBeNull();
    expect(screen.queryByLabelText("Nombre de tu empresa")).toBeNull();
    expect(screen.queryByLabelText("WhatsApp de tu empresa")).toBeNull();
    expect(container.querySelector("#registro-whatsapp-ayuda")).toBeNull();
  });

  it("sin remitente tampoco: sólo los términos y Google", async () => {
    const { container } = await pintar();

    const nombres = [...container.querySelectorAll("input, select, textarea")].map((campo) => campo.getAttribute("name"));
    expect(nombres).toEqual(["terminos"]);
  });

  it.each([
    ["ALTA_NUMERO_AUTOMATICO", "1"],
    ["ALTA_WABA_PROPIA", "1"],
  ])("con %s prendida la página es la misma: la ayuda del WhatsApp vive en /alta", async (bandera, valor) => {
    conRemitente();
    const sin = (await pintar()).container.innerHTML;
    document.body.innerHTML = "";

    process.env[bandera] = valor;
    process.env.META_APP_ID = "fake-app-id";
    process.env.META_ES_CONFIG_ID = "fake-config-id";
    process.env.WHATSAPP_APP_SECRET = "fake-app-secret";
    const con = (await pintar()).container.innerHTML;

    expect(con).toBe(sin);
  });

  it("no pide contraseña: la elige desde el enlace del correo", async () => {
    conRemitente();
    const { container } = await pintar();

    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it("el texto de ayuda cuenta que después se elige entre dar de alta la empresa o entrar a una", async () => {
    conRemitente();
    await pintar();

    expect(screen.getByText(/Creá tu cuenta con tu nombre y tu correo, o con Google\. Después elegís/)).toBeInTheDocument();
  });

  it("sin remitente del sistema la ayuda habla sólo de Google: no hay nombre ni correo que escribir", async () => {
    await pintar();

    expect(screen.getByText(/Creá tu cuenta con Google\. Después elegís/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/tu nombre y tu correo/);
  });

  it("sin remitente del sistema la ayuda en inglés también habla sólo de Google", async () => {
    h.locale.mockResolvedValue("en-US");
    await pintar();

    expect(screen.getByText(/Create your account with Google\. Next you choose/)).toBeInTheDocument();
  });

  it("tiene el enlace a /login", async () => {
    await pintar();

    expect(screen.getByRole("link", { name: "Iniciar sesión" })).toHaveAttribute("href", "/login");
  });
});

describe("/registro: «mi empresa ya usa ClaimMix»", () => {
  // La invitación se abre desde el enlace del correo, no desde /login. El SSO sí se entra desde /login: el texto lo nombra y apunta al enlace que está justo debajo.
  const TEXTO =
    "¿Tu empresa ya usa ClaimMix? Pedile a un administrador que te invite y seguí el enlace del correo que te llegue. Si tu empresa tiene SSO, también podés entrar con él desde «Iniciar sesión».";

  it("el texto es fijo: pide la invitación o el SSO desde «Iniciar sesión» y no nombra ninguna empresa", async () => {
    const { container } = await pintar();

    expect(screen.getByText(TEXTO)).toBeInTheDocument();
    // El rótulo del botón del SSO es del ingreso: se cita el enlace de esta página, no el botón.
    expect(container.textContent).not.toMatch(/Entrar con el SSO/);
    expect(screen.getByRole("link", { name: "Iniciar sesión" })).toHaveAttribute("href", "/login");
    expect(container.querySelector('a[href^="/invitacion"]')).toBeNull();
  });

  it("es el mismo texto con y sin remitente, con y sin Turnstile", async () => {
    await pintar();
    expect(screen.getByText(TEXTO)).toBeInTheDocument();
    document.body.innerHTML = "";

    conRemitente();
    conClaves();
    await pintar();
    expect(screen.getByText(TEXTO)).toBeInTheDocument();
  });

  it("en inglés", async () => {
    h.locale.mockResolvedValue("en-US");
    await pintar();

    expect(
      screen.getByText(
        "Does your company already use ClaimMix? Ask an administrator to invite you and follow the link in the email you receive. If your company has SSO, you can also use it from “Sign in”."
      )
    ).toBeInTheDocument();
    // El botón del SSO del ingreso está en castellano: citarlo en inglés mandaría a buscar un texto que no aparece.
    expect(document.body.textContent).not.toMatch(/Entrar con el SSO|Sign in with.*SSO/);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  });
});

describe("/registro: los botones", () => {
  it("sin remitente del sistema sólo está Google, y no están el nombre ni el correo", async () => {
    await pintar();

    expect(screen.getByRole("button", { name: "Continuar con Google" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Crear cuenta con mi correo" })).toBeNull();
    expect(screen.queryByLabelText("Nombre completo")).toBeNull();
    expect(screen.queryByLabelText("Correo electrónico")).toBeNull();
  });

  it("con remitente aparece «Crear cuenta con mi correo», con el nombre y el correo", async () => {
    conRemitente();
    await pintar();

    expect(screen.getByRole("button", { name: "Continuar con Google" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crear cuenta con mi correo" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nombre completo")).toBeInTheDocument();
    expect(screen.getByLabelText("Correo electrónico")).toBeInTheDocument();
  });

  it("el nombre y el correo no son obligatorios para el navegador: no pueden frenar a Google", async () => {
    conRemitente();
    await pintar();

    expect(screen.getByLabelText("Nombre completo")).not.toBeRequired();
    expect(screen.getByLabelText("Correo electrónico")).not.toBeRequired();
  });

  it("es un solo formulario con los dos botones", async () => {
    conRemitente();
    const { container } = await pintar();

    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(container.querySelectorAll("form button[type='submit']")).toHaveLength(2);
  });
});

describe("/registro: Turnstile", () => {
  it("sin claves no hay desafío ni script", async () => {
    conRemitente();
    const { container } = await pintar();

    expect(container.querySelector(".cf-turnstile")).toBeNull();
    expect(scriptDeTurnstile()).toBeNull();
  });

  it("con una sola clave tampoco", async () => {
    conRemitente();
    process.env.TURNSTILE_SITE_KEY = "test-turnstile-site-key";
    const { container } = await pintar();

    expect(container.querySelector(".cf-turnstile")).toBeNull();
    expect(scriptDeTurnstile()).toBeNull();
  });

  it("con las dos, el desafío con la clave pública y el script con el nonce de la CSP", async () => {
    conRemitente();
    conClaves();
    const { container } = await pintar();

    expect(container.querySelector(".cf-turnstile")).toHaveAttribute("data-sitekey", "test-turnstile-site-key");
    const script = scriptDeTurnstile();
    expect(script?.getAttribute("src")).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    expect(script?.getAttribute("nonce") ?? script?.nonce).toBe("nonce-de-prueba");
  });

  it("la caja sale vacía del servidor y se llena cuando llega el script", async () => {
    conRemitente();
    conClaves();
    const { container } = await pintar();
    const caja = container.querySelector(".cf-turnstile");
    expect(caja?.childElementCount).toBe(0);

    const turnstile = { render: vi.fn(() => "widget-1"), remove: vi.fn() };
    vi.stubGlobal("turnstile", turnstile);
    scriptDeTurnstile()?.dispatchEvent(new Event("load"));

    expect(turnstile.render).toHaveBeenCalledWith(caja, { sitekey: "test-turnstile-site-key" });
  });

  it("con el script ya cargado dibuja al montar, y al desmontar saca el desafío", async () => {
    conRemitente();
    conClaves();
    const turnstile = { render: vi.fn(() => "widget-1"), remove: vi.fn() };
    vi.stubGlobal("turnstile", turnstile);
    const { container, unmount } = await pintar();

    expect(turnstile.render).toHaveBeenCalledWith(container.querySelector(".cf-turnstile"), {
      sitekey: "test-turnstile-site-key",
    });
    unmount();
    expect(turnstile.remove).toHaveBeenCalledWith("widget-1");
  });

  it("la clave secreta no sale en el marcado", async () => {
    conRemitente();
    conClaves();
    const { container } = await pintar();

    expect(container.innerHTML).not.toContain("test-turnstile-secret-key");
  });

  it("sin la parte del correo no hay desafío: Google no lo usa", async () => {
    conClaves();
    const { container } = await pintar();

    expect(container.querySelector(".cf-turnstile")).toBeNull();
    expect(scriptDeTurnstile()).toBeNull();
  });
});

describe("/registro: los rechazos", () => {
  it.each([
    ["datos", /Revisá los datos\. Escribí tu nombre y un correo válido, y aceptá los términos/],
    ["terminos", /Para crear tu cuenta tenés que aceptar los términos/],
    ["intentos", /demasiados intentos/],
  ])("%s muestra su texto", async (motivo, texto) => {
    await pintar(motivo);

    expect(screen.getByRole("alert")).toHaveTextContent(texto);
  });

  it("«datos» no habla de la empresa ni del WhatsApp: ya no se piden acá", async () => {
    await pintar("datos");

    expect(screen.getByRole("alert")).not.toHaveTextContent(/empresa|WhatsApp/i);
  });

  it("«datos» en inglés", async () => {
    h.locale.mockResolvedValue("en-US");
    await pintar("datos");

    expect(screen.getByRole("alert")).toHaveTextContent("Check the details. Enter your name and a valid email, and accept the terms.");
  });

  it("«terminos» en inglés", async () => {
    h.locale.mockResolvedValue("en-US");
    await pintar("terminos");

    expect(screen.getByRole("alert")).toHaveTextContent("To create your account you need to accept the terms.");
  });

  it("«celular» ya no es un motivo: el número se pide en /alta", async () => {
    await pintar("celular");

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("un motivo que no está en la lista no muestra nada, ni se refleja", async () => {
    const { container } = await pintar("<img src=x onerror=alert(1)>");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.innerHTML).not.toContain("onerror");
  });

  it("un motivo heredado de Object.prototype tampoco", async () => {
    await pintar("constructor");

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("si el motivo viene repetido vale el último", async () => {
    await pintar(["datos", "intentos"]);

    expect(screen.getByRole("alert")).toHaveTextContent(/demasiados intentos/);
  });
});

describe("/registro: el idioma", () => {
  it("en inglés, todo en inglés", async () => {
    h.locale.mockResolvedValue("en-US");
    conRemitente();
    const { container } = await pintar();

    expect(container.querySelector("main")).toHaveAttribute("lang", "en-US");
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account with my email" })).toBeInTheDocument();
    expect(screen.queryByText(/Continuar con Google/)).toBeNull();
  });
});
