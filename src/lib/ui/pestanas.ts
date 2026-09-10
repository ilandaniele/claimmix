"use client";

/**
 * Las teclas que hacen que un grupo de botones sea un `tablist`.
 *
 * `role="tab"` y `aria-selected` son la mitad de la promesa. La otra mitad es
 * que las flechas muevan, que Inicio y Fin vayan a los extremos, y que un solo
 * botón esté en el orden de tabulación — sin eso, un lector de pantalla anuncia
 * «pestaña 2 de 7», la persona aprieta la flecha derecha y no pasa nada. Peor
 * que no haber dicho nunca que eran pestañas.
 *
 * Esto vivía dentro de `FilterTabs` y la consola del agente no lo tenía. Un
 * segundo lugar que lo necesita es donde se decide si esto se copia o se
 * comparte, y copiarlo es cómo terminan dos tablist con teclados distintos.
 *
 * Activación automática —elegir al moverse— porque en los dos casos mostrar el
 * panel es barato. Cuando no lo sea, el patrón correcto es otro: mover el foco
 * y elegir con Enter.
 */

import { useCallback, type KeyboardEvent, type RefObject } from "react";

export function useTeclasDePestanas(opciones: {
  cantidad: number;
  indiceActivo: number;
  elegir: (indice: number) => void;
  lista: RefObject<HTMLElement | null>;
}) {
  const { cantidad, indiceActivo, elegir, lista } = opciones;

  return useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const ultima = cantidad - 1;
      if (ultima < 0) return;
      const desde = indiceActivo === -1 ? 0 : indiceActivo;

      let destino: number | null = null;
      if (e.key === "ArrowRight") destino = desde === ultima ? 0 : desde + 1;
      else if (e.key === "ArrowLeft") destino = desde === 0 ? ultima : desde - 1;
      else if (e.key === "Home") destino = 0;
      else if (e.key === "End") destino = ultima;
      if (destino === null) return;

      e.preventDefault();
      elegir(destino);
      /*
       * El botón se busca por posición en el DOM y no por una ref por pestaña:
       * son hermanos en un contenedor, y un arreglo de refs para eso es más
       * máquina de la que hace falta.
       */
      lista.current?.querySelectorAll<HTMLElement>('[role="tab"]')[destino]?.focus();
    },
    [cantidad, indiceActivo, elegir, lista]
  );
}
