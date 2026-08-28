"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Poner o sacar un filtro de la URL, que es donde vive el estado de la bandeja.
 *
 * Este bloque —clonar los parámetros, poner o borrar el que cambió, borrar
 * `page`, empujar la ruta— estaba copiado en cada grupo de chips. Siete veces la
 * misma función, y la parte fácil de olvidar es el `delete("page")`: sin él,
 * cambiar de filtro estando en la página 4 te deja en la página 4 de un conjunto
 * que ahora tiene una sola.
 *
 * `null` saca el filtro. Los chips de «todos» pasan `null` en vez de repetir
 * cada uno su propio `if`.
 */
export function useFilterParam(): (clave: string, valor: string | null) => void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return useCallback(
    (clave: string, valor: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (valor === null) params.delete(clave);
      else params.set(clave, valor);

      // Cambiar de filtro siempre vuelve a la primera página: el conjunto es otro.
      params.delete("page");

      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );
}
