/**
 * El panel de tipos de siniestro propios (B26) lo pinta el servidor en el idioma
 * de la cuenta: los documentos y datos con su etiqueta traducida, y el nombre del
 * ramo en ese idioma. Un ramo del código conserva sus datos y su nombre.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

import { RamosPanel } from "@/app/(app)/agente/RamosPanel";
import { patronHtml } from "@/components/patron-html";
import { FORMATO_DE_CLAVE_DE_RAMO, type RamoDelInquilino } from "@/core/case/ramos";
import { CATALOGO_DE_DATOS } from "@/core/case/required-fields";
import { getT, type Locale } from "@/lib/i18n";

const PROPIO: RamoDelInquilino = {
  clave: "caucion",
  nombre_es: "Caución",
  nombre_en: "Surety bond",
  documentos: ["fotos_danos"],
  datos: ["testigos"],
};
const DEL_CODIGO: RamoDelInquilino = {
  clave: "consorcio",
  nombre_es: "Otro nombre",
  nombre_en: "Another name",
  documentos: ["fotos_danos"],
  datos: [],
};

// Sin los `value=""` de los campos: ahí viaja lo que escribió el administrador, en los dos idiomas.
const pintar = (idioma: Locale, ramos: RamoDelInquilino[]) =>
  renderToStaticMarkup(<RamosPanel t={getT(idioma)} idioma={idioma} ramos={ramos} pendiente={false} />).replace(
    /value="[^"]*"/g,
    ""
  );

describe("RamosPanel", () => {
  it("en en-US nombra el ramo, los documentos y los datos en inglés", () => {
    const html = pintar("en-US", [PROPIO]);

    expect(html).toContain("Surety bond");
    expect(html).toContain("Damage photos");
    expect(html).not.toContain("Fotos de los daños");
    expect(html).not.toContain("Caución");
    // Ninguna opción del catálogo se queda en español: todas tienen su etiqueta en el diccionario.
    for (const es of ["Certificado médico", "Testigos", "Número de denuncia", "Foto del vidrio roto", "Hay heridos"]) {
      expect(html, es).not.toContain(es);
    }
  });

  it("en es-AR los pinta en español", () => {
    const html = pintar("es-AR", [PROPIO]);

    expect(html).toContain("Caución");
    expect(html).toContain("Fotos de los daños");
    expect(html).not.toContain("Surety bond");
  });

  it("un ramo con la clave de uno del código se nombra con el del sistema y no ofrece los datos", () => {
    const html = pintar("en-US", [DEL_CODIGO]);

    expect(html).toContain("Condominium");
    expect(html).not.toContain("Another name");
    // Sólo el formulario de «Nuevo tipo» ofrece los datos: el de la fila del código no.
    expect(html.match(/name="datos\[\]"/g)).toHaveLength(CATALOGO_DE_DATOS.length);
  });

  it("un ramo propio sí ofrece los datos", () => {
    const html = pintar("en-US", [PROPIO]);

    expect(html.match(/name="datos\[\]"/g)).toHaveLength(CATALOGO_DE_DATOS.length * 2);
  });

  it("el pattern de la clave sale de la misma expresión que valida el servidor", () => {
    const html = pintar("es-AR", []);

    expect(html).toContain(`pattern="${patronHtml(FORMATO_DE_CLAVE_DE_RAMO)}"`);
  });
});
