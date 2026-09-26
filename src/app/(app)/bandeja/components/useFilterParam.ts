"use client";

import { useCallback } from "react";
import { usePathname } from "next/navigation";
import { useNavegacion } from "./navegacion-pendiente";

/**
 * Poner filtros multi-valor en la URL, que es donde vive el estado de la bandeja.
 *
 * Este bloque —clonar los parámetros, poner o borrar el que cambió, borrar
 * `page`, empujar la ruta— estaba copiado en cada grupo de chips. Siete veces la
 * misma función, y la parte fácil de olvidar es el `delete("page")`: sin él,
 * cambiar de filtro estando en la página 4 te deja en la página 4 de un conjunto
 * que ahora tiene una sola.
 *
 * Lista vacía saca el filtro. Si no, primero se borra lo que había puesto para
 * ese parámetro y después se agrega un valor por cada elemento de la lista, así
 * la URL queda `?type=choque&type=robo` y no un valor pisando al otro.
 */
export function useFilterParam(): (clave: string, valores: readonly string[]) => void {
  const { empujar, paramsVisibles } = useNavegacion();
  const pathname = usePathname();

  return useCallback(
    (clave: string, valores: readonly string[]) => {
      const params = new URLSearchParams(paramsVisibles.toString());
      params.delete(clave);
      for (const valor of valores) params.append(clave, valor);

      // Cambiar de filtro siempre vuelve a la primera página: el conjunto es otro.
      params.delete("page");

      empujar(`${pathname}?${params.toString()}`);
    },
    [empujar, pathname, paramsVisibles]
  );
}

/**
 * Sacar VARIOS filtros de una vez, que no es sacarlos de a uno en un bucle.
 *
 * «Limpiar» llamando a `setFilter(p, null)` cuatro veces empuja cuatro
 * navegaciones. Cada una arma su URL a partir del `searchParams` que este
 * render tenía, que es el de ANTES de las otras tres: las cuatro compiten y la
 * última que llega deja puestos los tres filtros que ella no borró. Es el mismo
 * bug que tendría un `setState` en bucle leyendo el valor viejo.
 *
 * Acá se borra todo sobre una sola copia y se empuja una sola vez.
 */
export function useLimpiarFiltros(): (params: string[]) => void {
  const { empujar, paramsVisibles } = useNavegacion();
  const pathname = usePathname();

  return useCallback(
    (params: string[]) => {
      const siguientes = new URLSearchParams(paramsVisibles.toString());
      for (const clave of params) siguientes.delete(clave);

      // Lo mismo que al filtrar: el conjunto es otro, la página vuelve a la 1.
      siguientes.delete("page");

      const query = siguientes.toString();
      empujar(query ? `${pathname}?${query}` : pathname);
    },
    [empujar, pathname, paramsVisibles]
  );
}

/**
 * Moverse por las páginas, que NO es lo mismo que filtrar.
 *
 * Comparte con `useFilterParam` el mismo bloque de clonar los parámetros y
 * empujar la ruta, y por eso vive acá al lado. Lo que cambia es justo lo que
 * hace falta que se note: filtrar borra `page` porque el conjunto es otro;
 * paginar lo pone.
 *
 * Estaban escritos a mano en `DashboardClient`, que eran las dos últimas copias
 * de este bloque en la bandeja.
 */
export function usePaginacion(): {
  irAPagina: (pagina: number) => void;
  cambiarTamanoDePagina: (porPagina: number) => void;
} {
  const { empujar, paramsVisibles } = useNavegacion();
  const pathname = usePathname();

  const irAPagina = useCallback(
    (pagina: number) => {
      const params = new URLSearchParams(paramsVisibles.toString());
      params.set("page", String(pagina));
      empujar(`${pathname}?${params.toString()}`);
    },
    [empujar, pathname, paramsVisibles]
  );

  const cambiarTamanoDePagina = useCallback(
    (porPagina: number) => {
      const params = new URLSearchParams(paramsVisibles.toString());
      params.set("per_page", String(porPagina));
      // La fila 1 del tamaño nuevo está siempre en la página 1: quedarse en el
      // número de página viejo puede caer más allá del final de una lista más
      // corta.
      params.set("page", "1");
      empujar(`${pathname}?${params.toString()}`);
    },
    [empujar, pathname, paramsVisibles]
  );

  return { irAPagina, cambiarTamanoDePagina };
}
