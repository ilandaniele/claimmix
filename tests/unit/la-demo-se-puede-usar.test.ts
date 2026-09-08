/**
 * Lo que se arregló de `/demo` y de la bandeja, fijado sobre el texto.
 *
 * Son afirmaciones sobre el archivo y no sobre el DOM, a propósito: lo que hay
 * que impedir es que alguien devuelva una clase o borre un atributo, y eso se
 * ve leyendo. Montar la pantalla para comprobar un color pediría un navegador
 * con el tema en oscuro, que es justamente lo que nadie va a correr.
 *
 * El archivo se lee normalizando finales de línea: acá es CRLF y en el
 * checkout de CI es LF.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const leer = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/**
 * El archivo SIN sus comentarios.
 *
 * La primera version de estas afirmaciones fallaba sobre los comentarios que
 * el propio arreglo agrega: el comentario que explica por que se saco
 * `bg-white/80` contiene, naturalmente, `bg-white/80`. Una prueba que se
 * dispara con su propia explicacion no comprueba nada del codigo.
 */
const sinComentarios = (s: string) =>
  s.replace(/{?\/\*[\s\S]*?\*\/}?/g, "").replace(/\/\/[^\n]*/g, "");

const DEMO_PAGE = sinComentarios(leer("src/app/demo/page.tsx"));
const DEMO_PUBLIC = sinComentarios(leer("src/app/demo/DemoPublic.tsx"));
const LAYOUT = leer("src/app/(app)/layout.tsx");
const TABLA = leer("src/app/(app)/bandeja/components/CasesTable.tsx");
const CONFIG = sinComentarios(leer("src/app/(app)/configuracion/page.tsx"));

describe("17 — la papelera invisible ya no se traga el foco", () => {
  it("aparece cuando el foco cae en ella o en su fila", () => {
    // `opacity-0` esconde pero NO saca del orden de tabulación: eran hasta
    // cien controles destructivos invisibles intercalados en el recorrido.
    expect(TABLA).toContain("focus-visible:opacity-100");
    expect(TABLA).toContain("group-focus-within:opacity-100");
  });

  it("y sigue apareciendo con el mouse, que es lo que ya andaba", () => {
    expect(TABLA).toContain("group-hover:opacity-100");
  });
});

describe("19 — /demo se puede leer en modo oscuro", () => {
  it("usa el fondo del producto y no un degradado propio", () => {
    // El degradado era `background-image` y los overrides del tema son
    // `background-color`: en oscuro sobrevivía el fondo claro con el h1 en
    // casi blanco encima. 1,05:1.
    expect(DEMO_PAGE).toContain('className="lienzo min-h-screen"');
    expect(DEMO_PAGE).not.toContain("bg-gradient-to-br from-slate-50 to-indigo-50");
  });

  it("la cabecera usa la variable del tema y no un blanco fijo", () => {
    // `.bg-white\/80` es otra clase que `.dark .bg-white`: el override no la
    // alcanzaba nunca.
    expect(DEMO_PAGE).toContain("bg-[var(--card-bg)]/80");
    expect(DEMO_PAGE).not.toContain("bg-white/80");
  });

  it("las chapas tienen par claro/oscuro", () => {
    // `bg-indigo-100` está reasignado en oscuro y `text-indigo-800` no: 1,15:1
    // en la chapa que dice de qué tipo es el siniestro. `bg-orange-100` no
    // tiene par y quedaba como una isla clara.
    expect(DEMO_PUBLIC).not.toContain("bg-indigo-100");
    expect(DEMO_PUBLIC).not.toContain("bg-orange-100");
  });
});

describe("20 — /demo anuncia lo que pasa", () => {
  it("tiene una región viva persistente para el progreso y el resultado", () => {
    // Entre el clic y el resultado hay varios segundos de llamada al modelo.
    expect(DEMO_PUBLIC).toContain('role="status" aria-live="polite"');
    expect(DEMO_PUBLIC).toContain("anuncioDeEtapa(stage, result, elapsed)");
  });

  it("y el panel de error se anuncia al aparecer", () => {
    // El 429 del tope por IP es un caso normal, no raro, y era mudo.
    expect(DEMO_PUBLIC).toContain('<div role="alert" className="rounded-xl border border-red-200');
  });
});

describe("21 — el texto chico se lee", () => {
  it("no queda ningún slate-400 en la demo ni en configuración", () => {
    // `text-slate-400` sobre blanco da 2,56:1 y todos los usos eran de 12 px:
    // no llega ni al piso de texto grande. Incluye el botón «Limpiar», que es
    // un control operable.
    expect(DEMO_PUBLIC).not.toContain("text-slate-400");
    expect(CONFIG).not.toContain("text-xs text-slate-400");
  });
});

describe("22 — se puede saltar al contenido", () => {
  it("el enlace existe y apunta al main", () => {
    // Entre once y catorce paradas de teclado antes del primer control útil,
    // en cada navegación. WCAG 2.4.1 es nivel A.
    expect(LAYOUT).toContain('href="#contenido"');
    expect(LAYOUT).toContain('<main id="contenido" tabIndex={-1}');
  });

  it("está antes de la barra lateral, que es lo único que lo hace servir", () => {
    // Cualquier control que se meta antes lo vuelve decorativo.
    expect(LAYOUT.indexOf('href="#contenido"')).toBeLessThan(LAYOUT.indexOf("<Sidebar"));
  });

  it("se destapa al enfocarlo, y no está oculto para el lector", () => {
    // Fuera de pantalla y no con `hidden`: tiene que existir para el lector.
    expect(LAYOUT).toContain("-translate-y-[200%]");
    expect(LAYOUT).toContain("focus:translate-y-0");
  });
});
