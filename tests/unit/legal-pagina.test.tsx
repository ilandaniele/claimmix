/**
 * /legal/[slug]/[pagina]: los términos, la privacidad y el borrado de datos de un cliente que
 * conecta WhatsApp con su propia app de Meta (src/app/legal/[slug]/[pagina]/page.tsx).
 *
 * Meta lee estas direcciones sin cuenta, así que la página no pide sesión; lo que cuida es que
 * un slug inventado, una página que no existe o un cliente sin datos cargados den lo mismo (404),
 * que no se indexe y que cada texto salga con la razón social, el CUIT y el contacto de quien es.
 */

import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  datos: vi.fn(),
  locale: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/lib/i18n/locale", () => ({ getServerLocale: h.locale }));
vi.mock("@/server/whatsapp/numeros", () => ({ datosLegalesDelSlug: h.datos }));

import PaginaLegal, { metadata } from "@/app/legal/[slug]/[pagina]/page";
import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esARServidor as esAR, type ClaveDelServidor } from "@/lib/i18n/es-AR.servidor";

const SLUG = "abcdefghij123456";
const DATOS = { razonSocial: "Aseguradora Sur SA", cuit: "30-12345678-9", contacto: "legal@example.com" };

const pagina = (slug: string, p: string) => PaginaLegal({ params: Promise.resolve({ slug, pagina: p }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.datos.mockResolvedValue(DATOS);
  h.locale.mockResolvedValue("es-AR");
});

describe("PaginaLegal: qué direcciones existen", () => {
  it("no se indexa ni se sigue", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it.each(["", "abc", "ABCDEFGHIJ123456", "abcdefghij12345", "abcdefghij1234567", "abcdefghij12345_", "../../etc/passwd"])(
    "el slug %j da 404 sin ir a la base",
    async (slug) => {
      await expect(pagina(slug, "terminos")).rejects.toThrow("NOT_FOUND");
      expect(h.datos).not.toHaveBeenCalled();
    }
  );

  it.each(["", "otra", "TERMINOS", "constructor", "__proto__", "toString"])("la página %j da 404 sin ir a la base", async (p) => {
    await expect(pagina(SLUG, p)).rejects.toThrow("NOT_FOUND");
    expect(h.datos).not.toHaveBeenCalled();
  });

  it("un slug que no es de nadie, o de un cliente sin datos cargados, da 404", async () => {
    h.datos.mockResolvedValue(null);

    await expect(pagina(SLUG, "privacidad")).rejects.toThrow("NOT_FOUND");
    expect(h.datos).toHaveBeenCalledWith(SLUG);
  });
});

describe("PaginaLegal: lo que muestra", () => {
  it.each([
    ["terminos", 5],
    ["privacidad", 5],
    ["borrado", 3],
  ] as const)("%s tiene su título, su introducción y %i secciones", async (p, secciones) => {
    render(await pagina(SLUG, p));

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(esAR[`legal.${p}.titulo` as ClaveDelServidor]);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(secciones);
    for (let n = 1; n <= secciones; n++) {
      expect(screen.getByRole("heading", { level: 2, name: esAR[`legal.${p}.s${n}.titulo` as ClaveDelServidor] })).toBeInTheDocument();
    }
  });

  it.each(["terminos", "privacidad", "borrado"])("%s no deja ningún marcador sin llenar, en los dos idiomas", async (p) => {
    for (const idioma of ["es-AR", "en-US"]) {
      h.locale.mockResolvedValue(idioma);
      const { container, unmount } = render(await pagina(SLUG, p));

      expect(container.textContent).not.toMatch(/\{(razonSocial|cuit|contacto)\}/);
      expect(container.textContent).toContain(DATOS.razonSocial);
      expect(container.textContent).toContain(DATOS.cuit);
      unmount();
    }
  });

  it("firma al pie con la razón social y el CUIT de quien es", async () => {
    render(await pagina(SLUG, "terminos"));

    expect(screen.getByText(esAR["legal.responsable"].replace("{razonSocial}", DATOS.razonSocial).replace("{cuit}", DATOS.cuit))).toBeInTheDocument();
  });

  it("el contacto del cliente sale en la página de privacidad", async () => {
    const { container } = render(await pagina(SLUG, "privacidad"));

    expect(container.textContent).toContain(DATOS.contacto);
  });

  it("sin contacto cargado dice que lo pida por la plataforma, en vez de dejar un hueco", async () => {
    h.datos.mockResolvedValue({ ...DATOS, contacto: null });

    const { container } = render(await pagina(SLUG, "privacidad"));

    expect(container.textContent).toContain(esAR["legal.contactoSin"]);
    expect(container.textContent).not.toContain("null");
  });

  it("repite el dato cuantas veces el texto lo pida", async () => {
    h.datos.mockResolvedValue({ ...DATOS, razonSocial: "A & B $1 SA" });

    const { container } = render(await pagina(SLUG, "terminos"));

    expect(container.textContent).toContain("A & B $1 SA");
    expect(container.textContent).not.toMatch(/\{razonSocial\}/);
  });

  it("enlaza a las otras dos páginas y marca en la que está", async () => {
    render(await pagina(SLUG, "privacidad"));

    const nav = screen.getByRole("navigation", { name: "Legal" });
    expect(within(nav).getByText(esAR["legal.nav.privacidad"])).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: esAR["legal.nav.terminos"] })).toHaveAttribute("href", `/legal/${SLUG}/terminos`);
    expect(within(nav).getByRole("link", { name: esAR["legal.nav.borrado"] })).toHaveAttribute("href", `/legal/${SLUG}/borrado`);
    expect(within(nav).queryByRole("link", { name: esAR["legal.nav.privacidad"] })).not.toBeInTheDocument();
  });

  it("se lee en el idioma del servidor", async () => {
    h.locale.mockResolvedValue("en-US");

    render(await pagina(SLUG, "terminos"));

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(enUSServidor["legal.terminos.titulo"]);
  });
});
