/**
 * El canal «web» (B17) y los ramos nuevos (B26) en las listas que los nombran:
 * el esquema, el filtro de la bandeja y los dos diccionarios. Si una de esas
 * listas se queda atrás, los casos entran pero no se pueden filtrar ni leer.
 */

import { describe, expect, it } from "vitest";

import { GRUPOS_DE_FILTRO } from "../../src/app/(app)/bandeja/components/grupos-de-filtro";
import { enUS } from "../../src/lib/i18n/en-US";
import { esAR } from "../../src/lib/i18n/es-AR";
import { ChannelSchema, ClaimTypeSchema } from "../../src/lib/schemas/cases";

const grupo = (param: string) => GRUPOS_DE_FILTRO.find((g) => g.param === param)!;

describe("canal web", () => {
  it("el esquema de canales lo acepta", () => {
    expect(ChannelSchema.parse("web")).toBe("web");
  });

  it("el filtro de canal de la bandeja ofrece exactamente los canales del esquema", () => {
    expect(grupo("channel").opciones.map((o) => o.clave).sort()).toEqual([...ChannelSchema.options].sort());
  });

  it("se lee «Formulario web» en español y «Web form» en inglés", () => {
    expect(esAR["channel.web"]).toBe("Formulario web");
    expect(enUS["channel.web"]).toBe("Web form");
  });
});

describe("ramos nuevos", () => {
  it.each(["art", "vida", "integral_comercio", "consorcio"])("%s es un ramo del esquema y del filtro", (ramo) => {
    expect(ClaimTypeSchema.options).toContain(ramo);
    expect(grupo("type").opciones.map((o) => o.clave)).toContain(ramo);
  });

  it("el filtro de tipo ofrece exactamente los ramos del esquema", () => {
    expect(grupo("type").opciones.map((o) => o.clave).sort()).toEqual([...ClaimTypeSchema.options].sort());
  });

  it("cada ramo tiene su nombre en los dos idiomas", () => {
    for (const ramo of ClaimTypeSchema.options) {
      const clave = `type.${ramo}` as keyof typeof esAR;
      expect(esAR[clave], `es-AR ${clave}`).toBeTruthy();
      expect(enUS[clave], `en-US ${clave}`).toBeTruthy();
    }
  });
});
