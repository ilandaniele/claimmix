/**
 * El CSV traducía 4 de 9 tipos y 5 de 13 estados.
 *
 * Los otros ocho salían con la clave de la base: una denuncia de
 * responsabilidad civil aparecía como `rc`, una lista para el core como
 * `listo_para_core`. Y el CSV es lo único de todo esto que ve alguien de
 * afuera: se abre en Excel, se manda por correo, se archiva. Se leía peor que
 * la pantalla, que sí traducía las trece.
 *
 * Los mapas del route son `Record<ClaimType, …>` y `Record<CaseStatus, …>`, así
 * que agregar un estado al esquema sin agregarlo ahí no compila. Estos tests
 * cubren lo que el tipo no puede: que la etiqueta exista de verdad en el
 * diccionario y no sea la clave disfrazada.
 */

import { describe, it, expect } from "vitest";

import { getT } from "@/lib/i18n";
import { CaseStatusSchema, ClaimTypeSchema } from "@/lib/schemas/cases";
import {
  etiquetasDeEstado,
  etiquetasDeTipo,
} from "@/app/api/cases/export.csv/route";

const t = getT("es-AR");

describe("las etiquetas del CSV", () => {
  it("tiene un nombre para los nueve tipos de siniestro", () => {
    const etiquetas = etiquetasDeTipo(t);
    for (const tipo of ClaimTypeSchema.options) {
      expect(etiquetas[tipo], `falta el tipo ${tipo}`).toBeTruthy();
    }
    expect(Object.keys(etiquetas)).toHaveLength(ClaimTypeSchema.options.length);
  });

  it("tiene un nombre para los trece estados", () => {
    const etiquetas = etiquetasDeEstado(t);
    for (const estado of CaseStatusSchema.options) {
      expect(etiquetas[estado], `falta el estado ${estado}`).toBeTruthy();
    }
    expect(Object.keys(etiquetas)).toHaveLength(CaseStatusSchema.options.length);
  });

  it("ninguna etiqueta es la clave de la base", () => {
    /*
     * Ésta es la que importa. Un diccionario al que le falta una clave devuelve
     * la clave, así que un mapa completo puede seguir escribiendo `rc` en el
     * archivo sin que falte nada a la vista.
     */
    const tipos = etiquetasDeTipo(t);
    for (const tipo of ClaimTypeSchema.options) {
      expect(tipos[tipo], `«${tipo}» sale crudo`).not.toBe(`type.${tipo}`);
      expect(tipos[tipo]).not.toBe(tipo);
    }

    const estados = etiquetasDeEstado(t);
    for (const estado of CaseStatusSchema.options) {
      expect(estados[estado], `«${estado}» sale crudo`).not.toBe(`status.${estado}`);
      expect(estados[estado]).not.toBe(estado);
    }
  });

  it("los que faltaban ahora dicen algo que se puede leer", () => {
    // Los cuatro que citaba el informe, por nombre.
    expect(etiquetasDeTipo(t).rc).toBe("Resp. Civil");
    expect(etiquetasDeTipo(t).robo_contenido).toBe("Robo de contenido");
    expect(etiquetasDeEstado(t).listo_para_core).toBe("Listo para Core");
    expect(etiquetasDeEstado(t).requiere_especialista).toBe("Requiere especialista");
  });

  it("acompaña el idioma de la pantalla", () => {
    // Un archivo en castellano bajado desde la interfaz en inglés se lee como
    // un error del producto.
    const en = getT("en-US");
    expect(etiquetasDeEstado(en).listo).not.toBe(etiquetasDeEstado(t).listo);
  });
});
