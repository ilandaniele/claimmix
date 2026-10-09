/**
 * /registro: qué se muestra.
 *
 * Un solo paso. «Continuar con Google» está siempre; «Crear cuenta con mi correo»
 * (con el nombre y el correo) sólo si hay remitente del sistema, porque sin él no
 * hay cómo mandar el enlace. El desafío de Turnstile sólo con las dos claves, y
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

// React 19 sube a <head> los scripts con `src` y `async`: se busca en todo el documento.
const scriptDeTurnstile = () => document.querySelector<HTMLScriptElement>('script[src^="https://challenges.cloudflare.com"]');

const conClaves = () => {
  process.env.TURNSTILE_SITE_KEY = "test-turnstile-site-key";
  process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret-key";
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.ALTA_NUMERO_AUTOMATICO;
  h.locale.mockResolvedValue("es-AR");
  h.remitente.mockReturnValue(null);
});

afterEach(() => {
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.ALTA_NUMERO_AUTOMATICO;
  scriptDeTurnstile()?.remove();
});

describe("/registro: los campos", () => {
  it("empresa, WhatsApp con el ejemplo «+54 9 …» y términos, todo obligatorio", async () => {
    await pintar();

    expect(screen.getByLabelText("Nombre de tu empresa")).toBeRequired();
    const whatsapp = screen.getByLabelText("WhatsApp de tu empresa");
    expect(whatsapp).toBeRequired();
    expect(whatsapp).toHaveAttribute("placeholder", "+54 9 …");
    expect(screen.getByText(/Con código de país/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeRequired();
    expect(screen.getByRole("link", { name: "términos de uso" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "política de privacidad" })).toHaveAttribute("href", "/privacy");
  });

  it("con el número por código prendido, la ayuda del WhatsApp suma que tiene que recibir SMS o llamada", async () => {
    process.env.ALTA_NUMERO_AUTOMATICO = "1";
    const { container } = await pintar();

    const ayuda = container.querySelector("#registro-whatsapp-ayuda");
    expect(ayuda).toHaveTextContent("Con código de país, por ejemplo +54 9 11 5555 0000.");
    expect(ayuda).toHaveTextContent("Tiene que poder recibir un SMS o una llamada y no puede estar en uso en la app de WhatsApp ni en WhatsApp Business.");
    expect(screen.getByLabelText("WhatsApp de tu empresa")).toHaveAccessibleDescription(/Tiene que poder recibir un SMS/);
  });

  it("con el número por código prendido, en inglés", async () => {
    process.env.ALTA_NUMERO_AUTOMATICO = "1";
    h.locale.mockResolvedValue("en-US");
    const { container } = await pintar();

    expect(container.querySelector("#registro-whatsapp-ayuda")).toHaveTextContent(
      "It must be able to receive an SMS or a phone call, and it can't be in use in the WhatsApp or WhatsApp Business app."
    );
  });

  it.each([undefined, "0", "true", ""])("con ALTA_NUMERO_AUTOMATICO=%j la ayuda del WhatsApp es la de hoy", async (valor) => {
    if (valor !== undefined) process.env.ALTA_NUMERO_AUTOMATICO = valor;
    const { container } = await pintar();

    expect(container.querySelector("#registro-whatsapp-ayuda")?.textContent).toBe("Con código de país, por ejemplo +54 9 11 5555 0000.");
  });

  it("los campos van por los nombres que leen las acciones", async () => {
    conRemitente();
    const { container } = await pintar();

    for (const nombre of ["empresa", "whatsapp", "terminos", "full_name", "email"]) {
      expect(container.querySelector(`[name="${nombre}"]`), nombre).not.toBeNull();
    }
  });

  it("no pide contraseña: la elige desde el enlace del correo", async () => {
    conRemitente();
    const { container } = await pintar();

    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it("tiene el enlace a /login", async () => {
    await pintar();

    expect(screen.getByRole("link", { name: "Iniciar sesión" })).toHaveAttribute("href", "/login");
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
    expect(script?.getAttribute("src")).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js");
    expect(script?.getAttribute("nonce") ?? script?.nonce).toBe("nonce-de-prueba");
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
    ["datos", /Revisá los datos/],
    ["intentos", /demasiados intentos/],
    ["celular", /¿Es un celular\? Escribilo con el 9 después del \+54/],
  ])("%s muestra su texto", async (motivo, texto) => {
    await pintar(motivo);

    expect(screen.getByRole("alert")).toHaveTextContent(texto);
  });

  it("«celular» en inglés pide el 9 en inglés", async () => {
    h.locale.mockResolvedValue("en-US");
    await pintar("celular");

    expect(screen.getByRole("alert")).toHaveTextContent(/Write it with the 9 after \+54/);
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
