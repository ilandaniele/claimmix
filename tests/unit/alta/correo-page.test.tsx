/**
 * /alta/correo: lo que ve quien vuelve del enlace de «Activar tu cuenta».
 *
 * Un enlace bueno muestra el formulario para elegir la contraseña, con el correo
 * de la cuenta. Uno vencido, adulterado o ausente muestra «enlace vencido» y la
 * salida a /registro. La pantalla no consulta la base: todo sale del enlace.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ locale: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/lib/i18n/locale", () => ({ getServerLocale: h.locale }));
vi.mock("@/app/alta/correo/actions", () => ({ crearCuentaDesdeCorreo: vi.fn() }));

import AltaCorreoPage, { metadata } from "@/app/alta/correo/page";
import { DURACION_DEL_TOKEN_MS, sellarToken } from "@/server/alta/token-de-registro";

const SECRETO = "fake-secreto-del-enlace-de-alta-0123456789";
const DATOS = {
  e: "ana@example.com",
  empresa: "Seguros del Sur",
  numero: "+5492916426930",
  nombre: "Ana Pérez",
  locale: "es-AR" as const,
};

async function pintar(t?: string | string[], e?: string | string[]) {
  const searchParams = { ...(t === undefined ? {} : { t }), ...(e === undefined ? {} : { e }) };
  return render(await AltaCorreoPage({ searchParams: Promise.resolve(searchParams) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BETTER_AUTH_SECRET = SECRETO;
  h.locale.mockResolvedValue("es-AR");
});

afterEach(() => {
  delete process.env.BETTER_AUTH_SECRET;
});

describe("/alta/correo con un enlace bueno", () => {
  it("muestra «Elegí tu contraseña» con el correo de la cuenta", async () => {
    await pintar(sellarToken(DATOS));

    expect(screen.getByRole("heading", { name: "Elegí tu contraseña" })).toBeInTheDocument();
    expect(screen.getByText("Cuenta para ana@example.com")).toBeInTheDocument();
  });

  it("pide la contraseña dos veces, de 8 a 128, y la declara nueva", async () => {
    const { container } = await pintar(sellarToken(DATOS));

    for (const nombre of ["password", "repetir"]) {
      const campo = container.querySelector(`input[name="${nombre}"]`);
      expect(campo, nombre).toHaveAttribute("type", "password");
      expect(campo).toHaveAttribute("autocomplete", "new-password");
      expect(campo).toHaveAttribute("minlength", "8");
      expect(campo).toHaveAttribute("maxlength", "128");
      expect(campo).toBeRequired();
    }
  });

  it("lleva el enlace en un campo oculto para que la acción lo vuelva a abrir", async () => {
    const t = sellarToken(DATOS);
    const { container } = await pintar(t);

    expect(container.querySelector('input[type="hidden"][name="t"]')).toHaveValue(t);
  });

  it("no muestra la empresa ni el teléfono", async () => {
    const { container } = await pintar(sellarToken(DATOS));

    expect(container.textContent).not.toMatch(/Seguros|5492916426930/);
  });

  it("habla en el idioma en que se pidió el alta, no en el del navegador", async () => {
    h.locale.mockResolvedValue("es-AR");
    const { container } = await pintar(sellarToken({ ...DATOS, locale: "en-US" }));

    expect(container.querySelector("main")).toHaveAttribute("lang", "en-US");
    expect(screen.getByRole("heading", { name: "Choose your password" })).toBeInTheDocument();
    expect(screen.getByText("Account for ana@example.com")).toBeInTheDocument();
  });

  it.each([
    ["clave", /entre 8 y 128 caracteres/],
    ["distintas", /no coinciden/],
    ["intentos", /demasiados intentos/],
    ["falla", /No pudimos crear tu cuenta/],
  ])("tras el motivo %s lo dice, y deja el formulario", async (motivo, texto) => {
    await pintar(sellarToken(DATOS), motivo);

    expect(screen.getByRole("alert")).toHaveTextContent(texto);
    expect(screen.getByRole("button", { name: "Crear mi cuenta" })).toBeInTheDocument();
  });

  it("un motivo que no está en la lista no muestra nada, ni se refleja", async () => {
    const { container } = await pintar(sellarToken(DATOS), "<img src=x onerror=alert(1)>");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.innerHTML).not.toContain("onerror");
  });
});

describe("/alta/correo con un enlace que no vale", () => {
  const vencido = () => {
    expect(screen.getByRole("heading", { name: "Enlace vencido" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a crear la cuenta" })).toHaveAttribute("href", "/registro");
  };

  it("sin enlace dice «enlace vencido»", async () => {
    const { container } = await pintar();

    vencido();
    expect(container.querySelector("form")).toBeNull();
  });

  it("con basura también", async () => {
    const { container } = await pintar("basura");

    vencido();
    expect(container.querySelector("form")).toBeNull();
  });

  it("adulterado también", async () => {
    const t = sellarToken(DATOS);
    const { container } = await pintar(`${t.slice(0, -2)}${t.endsWith("AA") ? "BB" : "AA"}`);

    vencido();
    expect(container.querySelector("form")).toBeNull();
  });

  it("vencido también, y no cuenta de quién era", async () => {
    const { container } = await pintar(sellarToken(DATOS, Date.now() - DURACION_DEL_TOKEN_MS - 1000));

    vencido();
    expect(container.textContent).not.toContain("ana@example.com");
  });

  it("sellado con otra clave también", async () => {
    const t = sellarToken(DATOS);
    process.env.BETTER_AUTH_SECRET = "fake-otro-secreto-que-no-es-el-de-antes-9876543210";
    await pintar(t);

    vencido();
  });

  it("un enlace repetido vale el último", async () => {
    await pintar(["basura", sellarToken(DATOS)]);

    expect(screen.getByRole("heading", { name: "Elegí tu contraseña" })).toBeInTheDocument();
  });

  it("sin enlace válido usa el idioma del navegador", async () => {
    h.locale.mockResolvedValue("en-US");
    await pintar("basura");

    expect(screen.getByRole("heading", { name: "Link expired" })).toBeInTheDocument();
  });
});

describe("/alta/correo: el enlace no viaja", () => {
  it("la página pide no mandar el referrer", () => {
    expect(metadata.referrer).toBe("no-referrer");
  });
});
