/**
 * El panel de la base del agente (pestaña «Base» de /agente) lo pinta el servidor, sin consultas:
 * las 21 secciones con su texto, la tabla de qué tipo de regla lee cada paso y el enlace a la propuesta.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EntrenamientoBasePanel } from "@/app/(app)/agente/EntrenamientoBasePanel";
import {
  VERSION_DEL_ENTRENAMIENTO_BASE,
  seccionesDelPaso,
} from "@/core/agente/entrenamiento-base";
import { PASOS_POR_TIPO } from "@/core/agente/indicaciones";
import { AVISO_DE_LA_PROPUESTA, PASOS_DEL_AGENTE } from "@/core/agente/propuesta";
import { getT, type Locale } from "@/lib/i18n";

const pintar = (idioma: Locale = "es-AR") =>
  renderToStaticMarkup(<EntrenamientoBasePanel t={getT(idioma)} idioma={idioma} />);

const escapar = (texto: string) =>
  texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const SECCIONES = PASOS_DEL_AGENTE.flatMap((paso) => seccionesDelPaso(paso));

afterEach(() => vi.unstubAllEnvs());

describe("EntrenamientoBasePanel", () => {
  it("pinta las 21 secciones, cada una con su id, su ruta y su texto entero", () => {
    const html = pintar();

    expect(SECCIONES).toHaveLength(21);
    expect(html.match(/<details/g)).toHaveLength(21);
    for (const s of SECCIONES) {
      expect(html, s.id).toContain(s.id);
      expect(html, s.ruta).toContain(s.ruta);
      expect(html, s.id).toContain(escapar(s.texto));
    }
    expect(html).toContain("whitespace-pre-wrap");
  });

  it("muestra la versión de la base y el modo de cada sección", () => {
    const html = pintar();

    expect(html).toContain(VERSION_DEL_ENTRENAMIENTO_BASE);
    expect(html).toContain("Prompt");
    expect(html).toContain("Sombra");
  });

  it("el título sale según el idioma y el texto sigue en castellano", () => {
    const es = pintar("es-AR");
    const en = pintar("en-US");
    const primera = SECCIONES[0]!;

    expect(es).toContain(escapar(primera.titulo["es-AR"]));
    expect(en).toContain(escapar(primera.titulo["en-US"]));
    expect(en).not.toContain(escapar(primera.titulo["es-AR"]));
    expect(en).toContain(escapar(primera.texto));
  });

  it("la tabla lista un renglón por tipo de regla, con el nombre que ya tiene en la consola", () => {
    const t = getT("es-AR");
    const html = pintar();

    expect(html.match(/<tr/g)).toHaveLength(Object.keys(PASOS_POR_TIPO).length + 1);
    for (const tipo of Object.keys(PASOS_POR_TIPO)) {
      expect(html, tipo).toContain(t(`reglas.tipo.${tipo}` as Parameters<typeof t>[0]));
    }
  });

  it("con la bandera apagada, decidir y redactar quedan tachados y lo dice", () => {
    const t = getT("es-AR");
    const html = pintar();

    // missing_fields lee decidir y reply_style lee redactar; la extracción siempre lee.
    expect(html.match(/data-activo="false"/g)).toHaveLength(2);
    expect(html).toContain(t("base.reglas.bandera_apagada"));
    expect(html).not.toContain(t("base.reglas.bandera_prendida"));
  });

  it("con la bandera prendida, todos los pasos de cada tipo leen", () => {
    vi.stubEnv("AGENTE_APRENDIDO_EN_CONVERSACION", "1");
    const t = getT("es-AR");
    const html = pintar();

    expect(html).not.toContain('data-activo="false"');
    expect(html).toContain(t("base.reglas.bandera_prendida"));
    expect(html).not.toContain(t("base.reglas.bandera_apagada"));
  });

  it("ofrece bajar la propuesta, con el aviso de que el repo es público", () => {
    const t = getT("es-AR");
    const html = pintar();

    expect(html).toContain('href="/api/admin/prompt-rules?formato=propuesta"');
    expect(html).toMatch(/<a [^>]*download/);
    expect(html).toContain(t("base.propuesta.boton"));
    expect(html).toContain(t("base.propuesta.aviso"));
  });

  it("el aviso de la propuesta es el mismo texto que escribe el archivo", () => {
    expect(getT("es-AR")("base.propuesta.aviso")).toBe(AVISO_DE_LA_PROPUESTA);
  });
});
