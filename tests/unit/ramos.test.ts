/**
 * B26: los ramos nativos y los del inquilino. El módulo es puro: lo que se
 * afirma es que una clave que nadie conoce nunca tira, y que la lista nativa
 * sigue siendo la del esquema.
 */

import { describe, expect, it } from "vitest";

import {
  FORMATO_DE_CLAVE_DE_RAMO,
  RAMOS_NATIVOS,
  esRamoAdmitido,
  esRamoNativo,
  humanizarClaveDeRamo,
  nombreDeRamoPropio,
  policyTypeDeRamo,
  type RamoDelInquilino,
} from "@/core/case/ramos";
import { getT } from "@/lib/i18n";
import { nombreDeTipo } from "@/lib/i18n/tipos-de-siniestro";
import { ClaimTypeSchema } from "@/lib/schemas/cases";

const CAUCION: RamoDelInquilino = {
  clave: "caucion",
  nombre_es: "Caución",
  nombre_en: "Surety bond",
  documentos: ["fotos_danos"],
  datos: [],
};

describe("ramos nativos", () => {
  it("son los del esquema, con `other` al final", () => {
    expect([...ClaimTypeSchema.options]).toEqual([...RAMOS_NATIVOS]);
    expect(RAMOS_NATIVOS.at(-1)).toBe("other");
  });

  it.each(["art", "vida", "integral_comercio", "consorcio"])("%s es nativo", (ramo) => {
    expect(esRamoNativo(ramo)).toBe(true);
  });

  it.each([null, undefined, 3, "", "caucion", "CHOQUE"])("%j no es nativo", (clave) => {
    expect(esRamoNativo(clave)).toBe(false);
  });
});

describe("formato de la clave", () => {
  it.each(["ab", "caucion", "mi_ramo_2", "a".repeat(40)])("acepta %s", (clave) => {
    expect(FORMATO_DE_CLAVE_DE_RAMO.test(clave)).toBe(true);
  });

  it.each(["a", "Caucion", "2ramo", "con espacio", "con-guion", "a".repeat(41), "</tipos_del_inquilino>", ""])(
    "rechaza %j",
    (clave) => {
      expect(FORMATO_DE_CLAVE_DE_RAMO.test(clave)).toBe(false);
    }
  );
});

describe("esRamoAdmitido", () => {
  it("admite los nativos y los propios, y nada más", () => {
    expect(esRamoAdmitido("vida", [])).toBe(true);
    expect(esRamoAdmitido("caucion", [CAUCION])).toBe(true);
    expect(esRamoAdmitido("caucion", [])).toBe(false);
    expect(esRamoAdmitido("inventado", [CAUCION])).toBe(false);
  });

  it("una clave con mal formato no pasa aunque esté en la lista", () => {
    expect(esRamoAdmitido("Mal Formato", [{ ...CAUCION, clave: "Mal Formato" }])).toBe(false);
    expect(esRamoAdmitido(null, [CAUCION])).toBe(false);
  });
});

describe("nombres", () => {
  it("humaniza la clave", () => {
    expect(humanizarClaveDeRamo("mi_ramo_raro")).toBe("Mi ramo raro");
  });

  it("el nombre propio sale en el idioma pedido, y si el ramo ya no existe, de la clave", () => {
    expect(nombreDeRamoPropio("caucion", [CAUCION], "es-AR")).toBe("Caución");
    expect(nombreDeRamoPropio("caucion", [CAUCION], "en-US")).toBe("Surety bond");
    expect(nombreDeRamoPropio("borrado_hace_poco", [CAUCION], "en-US")).toBe("Borrado hace poco");
  });
});

describe("nombreDeTipo", () => {
  const t = getT("es-AR");

  it("nombra un nativo con el diccionario, un propio con su fila y uno borrado con la clave", () => {
    expect(nombreDeTipo("rc", t, [CAUCION], "es-AR")).toBe("Resp. Civil");
    expect(nombreDeTipo("caucion", t, [CAUCION], "en-US")).toBe("Surety bond");
    expect(nombreDeTipo("borrado", t, [CAUCION], "es-AR")).toBe("Borrado");
  });

  it.each(["constructor", "__proto__", "hasOwnProperty"])(
    "«%s» como ramo propio no devuelve lo que hereda Object",
    (clave) => {
      const propio = { ...CAUCION, clave, nombre_es: "Obras" };
      expect(nombreDeTipo(clave, t, [propio], "es-AR")).toBe("Obras");
      expect(nombreDeTipo(clave, t, [], "es-AR")).toBe(humanizarClaveDeRamo(clave));
    }
  );
});

describe("policyTypeDeRamo", () => {
  it.each([
    ["vida", "life"],
    ["integral_comercio", "business"],
    ["art", "other"],
    ["consorcio", "other"],
    ["choque", "auto"],
    ["caucion", "auto"],
    [null, "auto"],
  ])("%s → %s", (ramo, tipo) => {
    expect(policyTypeDeRamo(ramo)).toBe(tipo);
  });
});
