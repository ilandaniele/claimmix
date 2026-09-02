/**
 * Que el texto del modo oscuro se pueda leer, medido y no a ojo.
 *
 * Los tres niveles de gris caían en el mismo #64748B, que sobre la tarjeta
 * oscura da 3,41:1 — AA pide 4,5. En /clientes eso es la columna de DNI, correo
 * y teléfono: los datos que alguien lee para llamar a una persona por teléfono.
 *
 * Este test lee `globals.css` porque los valores sólo existen ahí; no hay un
 * módulo al que preguntarle. Pero no busca un patrón: saca los colores de
 * verdad y calcula el contraste con la fórmula de WCAG. Si alguien vuelve a
 * poner un gris que no se lee, la cuenta da menos de 4,5 y esto se cae.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";

const CSS = readFileSync(path.resolve("src/app/globals.css"), "utf8");

/** El color que `globals.css` le pone a una clase en oscuro. */
function colorEnOscuro(selector: string): string {
  const re = new RegExp(
    `\\.dark\\s+\\.${selector}\\b[^{]*\\{[^}]*?(?:color|background-color):\\s*(#[0-9a-fA-F]{6})`,
    "s"
  );
  const m = re.exec(CSS);
  if (!m) throw new Error(`no encontré .dark .${selector} en globals.css`);
  return m[1];
}

/** Luminancia relativa, tal como la define WCAG 2.1. */
function luminancia(hex: string): number {
  const canales = [1, 3, 5]
    .map((i) => parseInt(hex.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * canales[0] + 0.7152 * canales[1] + 0.0722 * canales[2];
}

function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** AA para texto normal. */
const MINIMO = 4.5;

describe("el contraste del modo oscuro", () => {
  // Las tres superficies sobre las que se dibuja texto.
  const superficies = {
    "la tarjeta (.bg-white)": colorEnOscuro("bg-white"),
    "el fondo (.bg-slate-50)": colorEnOscuro("bg-slate-50"),
    "la fila resaltada (.bg-slate-100)": colorEnOscuro("bg-slate-100"),
  };

  it("el texto secundario —DNI, correo, teléfono— llega a AA en las tres superficies", () => {
    const gris = colorEnOscuro("text-slate-600");
    for (const [donde, fondo] of Object.entries(superficies)) {
      const r = contraste(gris, fondo);
      expect(r, `${gris} sobre ${fondo} (${donde}) da ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        MINIMO
      );
    }
  });

  it("el terciario también, que es donde viven los encabezados de columna", () => {
    const gris = colorEnOscuro("text-slate-400");
    for (const [donde, fondo] of Object.entries(superficies)) {
      const r = contraste(gris, fondo);
      expect(r, `${gris} sobre ${fondo} (${donde}) da ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        MINIMO
      );
    }
  });

  it("el texto principal sigue siendo el más claro de los tres", () => {
    /*
     * La jerarquía, que el colapso había borrado: los tres niveles salían
     * idénticos, así que la tabla no tenía forma de decir qué era más
     * importante. Subir el contraste sin esto habría dejado tres grises iguales
     * pero legibles, que es la mitad del arreglo.
     */
    const tarjeta = superficies["la tarjeta (.bg-white)"];
    const principal = contraste(colorEnOscuro("text-slate-900"), tarjeta);
    const secundario = contraste(colorEnOscuro("text-slate-600"), tarjeta);
    const terciario = contraste(colorEnOscuro("text-slate-400"), tarjeta);

    expect(principal).toBeGreaterThan(secundario);
    expect(secundario).toBeGreaterThan(terciario);
  });

  it("y el secundario queda a la par de lo que se ve en claro", () => {
    // En modo claro, slate-600 (#475569) sobre blanco da 7,58:1. La misma
    // lectura en los dos temas es el objetivo; que pase AA es el piso.
    const enClaro = contraste("#475569", "#FFFFFF");
    const enOscuro = contraste(
      colorEnOscuro("text-slate-600"),
      superficies["la tarjeta (.bg-white)"]
    );
    expect(Math.abs(enOscuro - enClaro)).toBeLessThan(1.5);
  });
});
