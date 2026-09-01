/**
 * La insignia de estado.
 *
 * Antes esto fijaba un matiz por estado —`listo` es `bg-green-100`, `procesando`
 * es `bg-blue-100`— para cinco de los trece estados que existen. Eso no era una
 * invariante sino una foto de la hoja de estilos: cualquier cambio de paleta lo
 * rompía sin que nada estuviera mal, y los otros ocho estados no los miraba
 * nadie.
 *
 * Lo que sí es una invariante, y es lo que se prueba acá:
 *
 *   1. Los trece estados tienen etiqueta, color y `data-status`. Trece, no cinco:
 *      un estado sin entrada en el mapa caía al color por defecto y se veía
 *      «terminado» aunque estuviera escalado.
 *
 *   2. El color agrupa por urgencia, no por estado. Los tres estados que piden
 *      una persona comparten color; los tres que esperan al denunciante también.
 *      Ésa es la razón de existir de la insignia: contestar «¿esto me espera a
 *      mí?» sin leer la palabra.
 *
 *   3. Ningún estado usa una familia de color que `globals.css` no pise en modo
 *      oscuro. Éste es el que de verdad protege algo: sumar un `bg-teal-50`
 *      queda perfecto en claro y sale casi blanco sobre fondo oscuro, y eso no
 *      se ve leyendo el diff — se ve mirando la pantalla, de noche, si alguien
 *      se acuerda de mirar.
 */

import { render, screen } from "@testing-library/react";
import { StatusBadge } from "../../src/app/(app)/bandeja/components/StatusBadge";
import { esAR } from "../../src/lib/i18n/es-AR";
import type { CaseStatus } from "../../src/lib/schemas/cases";

/** Los cinco tonos, con el fondo y el texto que le corresponde a cada uno. */
const TONOS = {
  actuar: ["bg-red-50", "text-red-700"],
  esperar: ["bg-amber-50", "text-amber-700"],
  enVuelo: ["bg-violet-50", "text-violet-700"],
  bien: ["bg-emerald-50", "text-emerald-700"],
  terminado: ["bg-slate-100", "text-slate-700"],
} as const;

/**
 * Los trece estados del CHECK de la base, con el tono que les toca.
 *
 * La etiqueta NO se escribe acá: sale del mismo diccionario del que la saca el
 * componente. Copiada a mano, este test sólo comprobaría que dos listas dicen lo
 * mismo, y se pondría rojo cada vez que alguien corrige una tilde.
 */
const ESTADOS: { status: CaseStatus; tono: keyof typeof TONOS }[] = [
  { status: "escalado", tono: "actuar" },
  { status: "requiere_especialista", tono: "actuar" },
  { status: "error_core", tono: "actuar" },
  { status: "esperando", tono: "esperar" },
  { status: "info_faltante", tono: "esperar" },
  { status: "confirmacion_pendiente", tono: "esperar" },
  { status: "recibido", tono: "enVuelo" },
  { status: "procesando", tono: "enVuelo" },
  { status: "listo", tono: "bien" },
  { status: "listo_para_core", tono: "bien" },
  { status: "enviado_a_core", tono: "terminado" },
  { status: "cerrado", tono: "terminado" },
  { status: "no_relevante", tono: "terminado" },
];

/** La etiqueta que le corresponde a un estado, según el diccionario. */
const etiquetaDe = (status: CaseStatus) => esAR[`status.${status}`];

function pintar(status: CaseStatus): HTMLElement {
  const { container } = render(<StatusBadge status={status} />);
  return container.firstElementChild as HTMLElement;
}

describe("StatusBadge", () => {
  for (const { status, tono } of ESTADOS) {
    it(`«${status}» se pinta con el tono «${tono}» y expone su data-status`, () => {
      const insignia = pintar(status);

      // Se ve la etiqueta del diccionario, no el nombre crudo del estado.
      expect(screen.getByText(etiquetaDe(status))).toBeInTheDocument();
      expect(insignia.textContent).not.toBe(status);

      // Fondo y texto: los dos, porque un fondo sin su color de texto es
      // exactamente el bug que produce una píldora ilegible.
      for (const clase of TONOS[tono]) {
        expect(insignia.className).toContain(clase);
      }

      // Los e2e apuntan por acá.
      expect(insignia.getAttribute("data-status")).toBe(status);
    });
  }

  it("los trece estados están cubiertos: ninguno cae al color por defecto", () => {
    // Si mañana el CHECK de la base suma un estado y este mapa no, la lista de
    // arriba deja de cubrirlo — y el estado nuevo se vería «terminado» (gris)
    // aunque fuera urgente. Esta cuenta es la que se pone en rojo.
    const ESTADOS_EN_LA_BASE = 13;
    expect(ESTADOS).toHaveLength(ESTADOS_EN_LA_BASE);
    expect(new Set(ESTADOS.map((e) => e.status)).size).toBe(ESTADOS_EN_LA_BASE);
  });

  it("el color agrupa por urgencia: los que piden una persona se ven igual entre sí", () => {
    const claseDe = (s: CaseStatus) => pintar(s).className;

    // Mismo tono → misma pintura.
    expect(claseDe("escalado")).toBe(claseDe("requiere_especialista"));
    expect(claseDe("esperando")).toBe(claseDe("info_faltante"));
    expect(claseDe("cerrado")).toBe(claseDe("no_relevante"));

    // Distinto tono → pintura distinta. «Escalado» y «esperando» son los dos
    // que más se confunden, y son justamente los que no pueden verse igual.
    expect(claseDe("escalado")).not.toBe(claseDe("esperando"));
    expect(claseDe("escalado")).not.toBe(claseDe("listo"));
  });

  it("ningún estado usa un color que el modo oscuro no pise", () => {
    /*
     * `globals.css` implementa el modo oscuro pisando utilidades de Tailwind con
     * `!important`. Una familia sin override —teal, sky, rose, lime— se queda
     * clara sobre fondo oscuro: texto casi blanco sobre fondo casi blanco.
     *
     * Esta lista es la de las familias que el archivo efectivamente pisa. Si
     * alguien suma un color nuevo a la insignia, este test lo obliga a pasar
     * antes por `globals.css`.
     */
    const CON_MODO_OSCURO = [
      "slate",
      "red",
      "amber",
      "emerald",
      "violet",
      "indigo",
      "orange",
      "yellow",
      "blue",
    ];

    for (const { status } of ESTADOS) {
      const clases = pintar(status).className.split(/\s+/);
      const colores = clases.filter((c) => /^(bg|text|border)-[a-z]+-\d{2,3}$/.test(c));

      // Que haya color, para que el filtro de abajo no pase por vacío.
      expect(colores.length).toBeGreaterThan(0);

      for (const clase of colores) {
        const familia = clase.split("-")[1]!;
        expect(
          CON_MODO_OSCURO,
          `${status} usa "${clase}" y globals.css no pisa la familia "${familia}" en modo oscuro`
        ).toContain(familia);
      }
    }
  });
});
