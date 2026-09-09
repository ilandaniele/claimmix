"use client";

/**
 * El foco de un diálogo modal: adentro al abrir, atrapado mientras está
 * abierto, de vuelta a donde estaba al cerrar, y Escape cierra.
 *
 * ── Por qué un hook y no una tercera copia ──────────────────────────────────
 *
 * El bloque estaba escrito DOS veces, palabra por palabra: `CloseConfirmDialog`
 * y `EscalateDialog`. Diferían en una sola cosa —el selector de lo enfocable,
 * `input, select` en uno y `textarea` en el otro—, porque cada copia enumeraba
 * lo que ESE diálogo tenía adentro. Agregarle un campo a un diálogo le rompía
 * la trampa en silencio. Acá el selector es uno solo y nombra todo lo que el
 * navegador pone en el orden de tabulación.
 *
 * Los otros dos —el de borrar de la bandeja y el de simular— nunca tuvieron el
 * bloque: declaraban `role="dialog" aria-modal="true"` y nada más. Con
 * `aria-modal` puesto y el foco afuera, el lector de pantalla esconde todo y
 * deja a la persona parada en la nada.
 *
 * Y el argumento que más pesa no es el de accesibilidad: **Escape no cerraba el
 * diálogo**, y eso lo sufre todo el mundo, con mouse incluido.
 *
 * Con el de borrar dolía de verdad, porque las filas de la bandeja son
 * enfocables: tabulando se salía del diálogo, se caía en la lista de atrás y
 * Espacio seguía marcando filas.
 *
 * ── Lo que NO hace ──────────────────────────────────────────────────────────
 *
 * No pone `inert` ni `aria-hidden` sobre el fondo. El fondo sigue vivo para
 * todo lo que no sea Tab, así que qué queda marcado después de borrar lo sigue
 * decidiendo la poda de `CasesTable`, no este diálogo.
 */
import { useEffect, useRef, type RefObject } from "react";

/** Todo lo tabulable, sin lo deshabilitado: un elemento apagado no recibe foco. */
const ENFOCABLES =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Devuelve el ref que va en el PANEL del diálogo (el div de adentro, no el
 * telón). `focoInicial` es opcional: sin él se enfoca lo primero enfocable del
 * panel.
 */
export function useDialogoModal<T extends HTMLElement = HTMLDivElement>(
  alCerrar: () => void,
  focoInicial?: RefObject<HTMLElement | null>
): RefObject<T | null> {
  const panel = useRef<T>(null);

  /*
   * Este efecto NO depende de `alCerrar`. Tres de los cuatro diálogos lo
   * reciben como flecha en línea, o sea identidad nueva en cada render: si
   * dependiera de él, volvería a enfocar en cada tecla y le robaría el foco a
   * quien está escribiendo el motivo de la derivación.
   */
  useEffect(() => {
    const anterior = document.activeElement as HTMLElement | null;

    (
      focoInicial?.current ?? panel.current?.querySelector<HTMLElement>(ENFOCABLES)
    )?.focus();

    return () => {
      // Puede haber desaparecido: se borró la fila que lo tenía, o el diálogo
      // navegó a otra pantalla al cerrar el siniestro.
      if (anterior?.isConnected) anterior.focus({ preventScroll: true });
    };
  }, [focoInicial]);

  useEffect(() => {
    function alApretar(e: KeyboardEvent) {
      if (e.key === "Escape") {
        alCerrar();
        return;
      }

      if (e.key !== "Tab" || !panel.current) return;

      const enfocables = panel.current.querySelectorAll<HTMLElement>(ENFOCABLES);

      /*
       * El hueco que se abría justo mientras se guardaba.
       *
       * `ENFOCABLES` excluye lo deshabilitado, y `EscalateDialog` y
       * `CloseConfirmDialog` deshabilitan el textarea y los dos botones
       * mientras `loading` es true. En esa ventana la lista sale VACÍA:
       * `primero` y `ultimo` quedaban `undefined`, ninguna de las dos ramas de
       * abajo disparaba `preventDefault`, y el Tab se escapaba del diálogo a la
       * bandeja de atrás, que tiene filas enfocables.
       *
       * Con la lista vacía no hay a dónde ir adentro, así que el Tab no va a
       * ningún lado. El foco se queda en el panel, que se hace enfocable sólo
       * para esto: es el único momento en que un diálogo no tiene nada que
       * ofrecer, y dura lo que tarda el guardado.
       */
      if (enfocables.length === 0) {
        e.preventDefault();
        panel.current.tabIndex = -1;
        panel.current.focus({ preventScroll: true });
        return;
      }

      const primero = enfocables[0];
      const ultimo = enfocables[enfocables.length - 1];

      if (e.shiftKey && document.activeElement === primero) {
        e.preventDefault();
        ultimo?.focus();
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault();
        primero?.focus();
      }
    }

    document.addEventListener("keydown", alApretar);
    return () => document.removeEventListener("keydown", alApretar);
  }, [alCerrar]);

  return panel;
}
