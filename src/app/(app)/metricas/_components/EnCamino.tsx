"use client";

/**
 * La señal de que el cambio de unidad está en camino.
 *
 * Cambiar `?serie=` sólo vuelve a dibujar la página, no el segmento, así que el
 * `loading.tsx` de `(app)` no sale de nuevo: Next deja la unidad vieja marcada
 * hasta que termina el viaje a Neon, que en frío son segundos sin nada que diga
 * que el clic llegó. Siempre dibujada y del mismo tamaño, para no correr el
 * rótulo cuando aparece.
 */

import { useLinkStatus } from "next/link";

export function EnCamino() {
  const { pending } = useLinkStatus();
  return (
    <span
      data-testid="en-camino"
      aria-hidden="true"
      className={`ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current ${
        pending ? "animate-pulse" : "invisible"
      }`}
    />
  );
}
