/**
 * Puntos 18 y 23: el foco de los diálogos y la fila que se puede abrir aparte.
 *
 * Son afirmaciones sobre el texto de los archivos, normalizando finales de
 * línea y sacando los comentarios antes de mirar —el comentario que explica
 * por qué se sacó algo contiene, naturalmente, eso que se sacó—.
 *
 * Lo que hay que impedir es que vuelva una copia del bloque de foco, o que el
 * enlace vuelva a ser un `<span>`, y eso se ve leyendo. Montar los cuatro
 * diálogos para comprobar el orden del Tab pediría un navegador de verdad.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const leer = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const sinComentarios = (s: string) =>
  s.replace(/{?\/\*[\s\S]*?\*\/}?/g, "").replace(/\/\/[^\n]*/g, "");

const HOOK = leer("src/app/(app)/_components/dialogo-modal.ts");
const CERRAR = sinComentarios(leer("src/app/(app)/casos/[id]/components/CloseConfirmDialog.tsx"));
const DERIVAR = sinComentarios(leer("src/app/(app)/casos/[id]/components/EscalateDialog.tsx"));
const BANDEJA = sinComentarios(leer("src/app/(app)/bandeja/DashboardClient.tsx"));
const SIMULAR = sinComentarios(leer("src/app/(app)/bandeja/components/SimulateModal.tsx"));
const TABLA = sinComentarios(leer("src/app/(app)/bandeja/components/CasesTable.tsx"));

describe("18 — el foco de un diálogo modal vive en un solo lugar", () => {
  it("el hook hace las cuatro cosas", () => {
    // Enfocar al abrir, atrapar el Tab, devolver el foco al cerrar, y Escape.
    expect(HOOK).toContain('e.key === "Escape"');
    expect(HOOK).toContain('e.key !== "Tab"');
    expect(HOOK).toContain("anterior.focus({ preventScroll: true })");
  });

  it("su selector nombra todo lo tabulable, no lo que cada diálogo tenía adentro", () => {
    // Las dos copias enumeraban lo suyo —`input, select` en una, `textarea` en
    // la otra— así que agregarle un campo a un diálogo le rompía la trampa en
    // silencio.
    for (const etiqueta of ["a[href]", "button", "input", "select", "textarea", "[tabindex]"]) {
      expect(HOOK).toContain(etiqueta);
    }
  });

  it("los cuatro diálogos lo usan", () => {
    // Dos lo tenían copiado; los otros dos —borrar y simular— no lo tenían.
    for (const archivo of [CERRAR, DERIVAR, BANDEJA, SIMULAR]) {
      expect(archivo).toContain("useDialogoModal");
    }
  });

  it("y ninguno se quedó con su copia del bloque", () => {
    // Si vuelve un `querySelectorAll` de enfocables adentro de un diálogo, es
    // que alguien copió el bloque otra vez.
    for (const archivo of [CERRAR, DERIVAR, BANDEJA, SIMULAR]) {
      expect(archivo).not.toContain('tabindex="-1"');
      expect(archivo).not.toContain('e.key === "Escape"');
    }
  });

  it("el de borrar arranca el foco en Cancelar y no en la casilla", () => {
    // Este diálogo BORRA: llegar al botón rojo pide un Tab a propósito.
    expect(BANDEJA).toContain("useDialogoModal<HTMLDivElement>(onCancel, cancelarRef)");
    expect(BANDEJA).toContain("ref={cancelarRef}");
  });
});

describe("23 — una fila se puede abrir en otra pestaña", () => {
  it("el identificador es un enlace de verdad", () => {
    // Era un <span> y la fila navegaba con `router.push`: Ctrl+clic abría el
    // caso en la MISMA pestaña, el botón del medio no hacía nada, y no había
    // «copiar dirección del enlace» porque no había dirección.
    expect(TABLA).toContain("<Link");
    expect(TABLA).toContain("href={`/casos/${id}`}");
  });

  it("no se prefetchean cien casos al abrir la lista", () => {
    // La bandeja muestra hasta 100 filas y el plan es Hobby.
    expect(TABLA).toContain("prefetch={false}");
  });

  it("el enlace no suma cien paradas de Tab", () => {
    // El punto de foco sigue siendo la fila. `tabIndex={-1}` no lo esconde del
    // lector: lo sigue anunciando como enlace.
    expect(TABLA).toContain("tabIndex={-1}");
  });

  it("en modo selección vuelve a ser texto", () => {
    // Ahí tocar la fila la MARCA, y un <a> en el medio se llevaría ese clic a
    // otra pantalla.
    expect(TABLA).toContain("if (seleccionando) {");
    expect(TABLA).toContain("<span className={pinta}>{formatCaseId(id)}</span>");
  });

  it("el clic no navega dos veces", () => {
    // Sin esto el clic sube al <tr> y se empuja dos veces al mismo caso: dos
    // entradas de historial, y el «atrás» pidiendo dos toques.
    expect(TABLA).toContain("onClick={(e) => e.stopPropagation()}");
  });
});
