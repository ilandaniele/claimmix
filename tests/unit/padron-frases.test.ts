/**
 * Las frases del padrón (B16): que todo código que las rutas pueden devolver
 * tenga su frase en los dos idiomas, y cómo se arman las líneas de un resultado.
 */

import { describe, expect, it } from "vitest";

import { ERRORES_DE_ARCHIVO, ERRORES_DE_FILA } from "@/core/padron/filas";
import { ERRORES_MANUALES } from "@/core/padron/manual";
import { getT, type Locale } from "@/lib/i18n";
import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";
import { conTopes, lineasDelPadron, motivoDe } from "@/server/padron/lineas";

const IDIOMAS: Locale[] = ["es-AR", "en-US"];
const CODIGOS = [...ERRORES_DE_ARCHIVO, ...ERRORES_DE_FILA, ...ERRORES_MANUALES];
const marcas = (texto: string) => (texto.match(/\{\w+\}/g) ?? []).sort();

const CERO = { altas: 0, cambios: 0, iguales: 0 };
const datos = (d: Partial<Parameters<typeof lineasDelPadron>[1]> = {}) => ({
  aplicado: false,
  resumen: { clientes: { ...CERO }, polizas: { ...CERO } },
  errores: [],
  erroresTotal: 0,
  ignoradas: [],
  ...d,
});

describe("cobertura de las frases del padrón", () => {
  it("no hay códigos repetidos entre archivo, fila y alta a mano", () => {
    expect(new Set(CODIGOS).size).toBe(CODIGOS.length);
  });

  it.each(IDIOMAS)("todo código de rechazo tiene su frase en %s", (idioma) => {
    const t = getT(idioma);
    for (const codigo of CODIGOS) {
      const frase = motivoDe(t, codigo);
      expect(frase, codigo).toBeTruthy();
      expect(frase, codigo).not.toMatch(/\{\w+\}/);
    }
  });

  it("las claves `padron.*` son las mismas en los dos diccionarios y con las mismas marcas", () => {
    const claves = (d: Record<string, string>) => Object.keys(d).filter((k) => k.startsWith("padron."));
    expect(claves(enUSServidor).sort()).toEqual(claves(esARServidor).sort());
    for (const clave of claves(esARServidor)) {
      const es = (esARServidor as Record<string, string>)[clave]!;
      const en = (enUSServidor as Record<string, string>)[clave]!;
      expect(marcas(en), clave).toEqual(marcas(es));
    }
  });

  it("los topes que las frases nombran salen de las constantes, no de un número copiado", () => {
    const t = getT("es-AR");
    expect(motivoDe(t, "archivo_muy_grande")).toBe("El archivo pesa más de 512 KB.");
    expect(motivoDe(t, "demasiadas_filas")).toMatch(/más de \d+ filas/);
    expect(conTopes("{kb} {filas} {columnas}")).toMatch(/^512 \d+ \d+$/);
  });
});

describe("lineasDelPadron", () => {
  const t = getT("es-AR");

  it("una vista previa dice que no se guardó nada y da las cuentas", () => {
    const lineas = lineasDelPadron(
      t,
      datos({ resumen: { clientes: { altas: 2, cambios: 1, iguales: 3 }, polizas: { altas: 4, cambios: 0, iguales: 0 } } })
    );
    expect(lineas).toEqual([
      "Vista previa: todavía no se guardó nada.",
      "Clientes: 2 nuevos, 1 con cambios, 3 sin cambios.",
      "Pólizas: 4 nuevas, 0 con cambios, 0 sin cambios.",
    ]);
  });

  it("una importación hecha lo dice", () => {
    const lineas = lineasDelPadron(
      t,
      datos({ aplicado: true, resumen: { clientes: { ...CERO, altas: 1 }, polizas: { ...CERO } } })
    );
    expect(lineas[0]).toBe("Importación hecha.");
  });

  it("un archivo sin novedades dice que el padrón ya está así", () => {
    const lineas = lineasDelPadron(t, datos({ resumen: { clientes: { ...CERO, iguales: 2 }, polizas: { ...CERO } } }));
    expect(lineas[0]).toBe("El archivo no trae nada nuevo: el padrón ya está así.");
  });

  it("con errores no se muestran las cuentas: no ocurre nada de eso", () => {
    const lineas = lineasDelPadron(
      t,
      datos({
        errores: [{ fila: 4, codigo: "dni_invalido" }],
        erroresTotal: 1,
        resumen: { clientes: { ...CERO, altas: 9 }, polizas: { ...CERO } },
      })
    );
    expect(lineas).toEqual([
      "No se importó nada. Corregí las filas con error y volvé a subir el archivo.",
      "Fila 4: El DNI no es válido: tiene que tener de 6 a 9 números.",
    ]);
  });

  it("cuenta los errores que no entran en la lista", () => {
    const lineas = lineasDelPadron(
      t,
      datos({
        errores: [
          { fila: 2, codigo: "dni_invalido" },
          { fila: 3, codigo: "dni_requerido" },
        ],
        erroresTotal: 7,
      })
    );
    expect(lineas.at(-1)).toBe("Y 5 errores más.");
  });

  it("informa las columnas ignoradas, antes de los errores", () => {
    const lineas = lineasDelPadron(
      t,
      datos({ ignoradas: ["color", "talle"], errores: [{ fila: 2, codigo: "dni_invalido" }], erroresTotal: 1 })
    );
    expect(lineas[1]).toBe("Columnas que no se reconocieron y se ignoraron: color, talle.");
    expect(lineas[2]).toMatch(/^Fila 2:/);
  });

  it("habla en el idioma que se le pasa", () => {
    const lineas = lineasDelPadron(
      getT("en-US"),
      datos({ errores: [{ fila: 2, codigo: "dni_invalido" }], erroresTotal: 1 })
    );
    expect(lineas[0]).toBe("Nothing was imported. Fix the rows with errors and upload the file again.");
    expect(lineas[1]).toMatch(/^Row 2: /);
  });

  it("ninguna línea deja una marca sin reemplazar", () => {
    for (const idioma of IDIOMAS) {
      const lineas = lineasDelPadron(
        getT(idioma),
        datos({
          errores: [{ fila: 2, codigo: "poliza_de_otro_titular" }],
          erroresTotal: 3,
          ignoradas: ["x"],
        })
      );
      for (const linea of lineas) expect(linea).not.toMatch(/\{\w+\}/);
    }
  });
});
