/**
 * La página pública de denuncias (B17) no lleva JavaScript: si el servidor
 * rechaza un envío, el formulario vuelve vacío. Por eso cada campo trae en
 * `pattern` la misma expresión que valida la ruta, y un texto que explica el
 * formato: el navegador frena el error antes de que se pierda el relato.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ inquilinoDelFormulario: vi.fn(), idioma: "es-AR" }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "accept-language": m.idioma }) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/server/web/formulario", () => ({ inquilinoDelFormulario: m.inquilinoDelFormulario }));
vi.mock("@/server/web/token", () => ({ firmarToken: () => "token-de-prueba" }));

import DenunciaWebPage from "@/app/denuncia/[slug]/page";
import { ETIQUETA } from "@/components/estilos-de-formulario";
import { patronHtml } from "@/components/patron-html";
import { PATRON_DE_CORREO, PATRON_DE_NOMBRE, PATRON_DE_TELEFONO } from "@/core/web/formulario";
import { getT } from "@/lib/i18n";

const pintar = async () =>
  renderToStaticMarkup(
    await DenunciaWebPage({ params: Promise.resolve({ slug: "mi-aseguradora" }), searchParams: Promise.resolve({}) })
  );

/** La etiqueta de apertura del campo `name`, con sus atributos como los ve el navegador (sin el escape de HTML). */
const campo = (html: string, name: string) =>
  html
    .match(new RegExp(`<(?:input|textarea)[^>]*name="${name}"[^>]*>`))![0]
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");

beforeEach(() => {
  m.idioma = "es-AR";
  m.inquilinoDelFormulario.mockResolvedValue({ tenantId: "t", nombre: "Aseguradora" });
});

describe("la página pública de denuncias", () => {
  it("nombre, correo y teléfono llevan como pattern la expresión de la ruta", async () => {
    const html = await pintar();

    expect(campo(html, "nombre")).toContain(`pattern="${patronHtml(PATRON_DE_NOMBRE)}"`);
    expect(campo(html, "email")).toContain(`pattern="${patronHtml(PATRON_DE_CORREO)}"`);
    expect(campo(html, "telefono")).toContain(`pattern="${patronHtml(PATRON_DE_TELEFONO)}"`);
  });

  it("cada pattern trae su explicación, la que sale en el aviso del navegador", async () => {
    const html = await pintar();
    const t = getT("es-AR");

    expect(campo(html, "nombre")).toContain(`title="${t("denuncia.nombreFormato")}"`);
    expect(campo(html, "email")).toContain(`title="${t("denuncia.emailFormato")}"`);
    expect(campo(html, "telefono")).toContain(`title="${t("denuncia.telefonoFormato")}"`);
  });

  it("la regla de cada campo se ve en la página y el campo la enlaza con aria-describedby", async () => {
    const html = await pintar();
    const t = getT("es-AR");
    const pagina = document.createElement("div");
    pagina.innerHTML = html;

    for (const [nombre, clave] of [
      ["nombre", "denuncia.nombreFormato"],
      ["email", "denuncia.emailFormato"],
      ["telefono", "denuncia.telefonoFormato"],
    ] as const) {
      expect(campo(html, nombre)).toContain(`aria-describedby="${nombre}-formato"`);
      expect(pagina.querySelector(`#${nombre}-formato`)?.textContent).toBe(t(clave));
    }
  });

  it.each([
    ["es-AR", "es-AR"],
    ["en-US,en;q=0.9", "en-US"],
  ])("con Accept-Language %s el contenido declara lang=%s", async (cabecera, lang) => {
    m.idioma = cabecera;

    expect(await pintar()).toContain(`<main lang="${lang}"`);
  });

  it("los tres textos de formato existen en los dos idiomas", () => {
    for (const idioma of ["es-AR", "en-US"] as const) {
      const t = getT(idioma);
      for (const clave of ["denuncia.nombreFormato", "denuncia.emailFormato", "denuncia.telefonoFormato"] as const) {
        expect(t(clave), `${idioma} ${clave}`).not.toBe(clave);
      }
    }
  });

  it("las etiquetas usan la clase compartida de los formularios", async () => {
    const html = await pintar();

    expect(html.match(new RegExp(`<label class="${ETIQUETA}">`, "g"))).toHaveLength(4);
  });
});
