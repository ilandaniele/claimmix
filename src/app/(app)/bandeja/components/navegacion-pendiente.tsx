"use client";

/**
 * La bandeja responde al click ANTES de que el servidor conteste.
 *
 * Todo el estado de la bandeja vive en la URL: filtros, pestaña, página y
 * tamaño de página. Cambiarlo era `router.push`, y hasta que el servidor
 * devolvía la página nueva no se movía NADA — ni el desplegable mostraba el
 * número elegido, ni la pestaña se resaltaba, ni la lista decía que estaba
 * trabajando. En un enlace lento, eso se lee como «apreté y no cambió», que fue
 * exactamente el reporte.
 *
 * Acá hay UNA transición para toda la bandeja, y dos cosas que salen de ella:
 *
 *   · `pending`: la navegación está en vuelo. La lista lo usa para atenuarse y
 *     mostrar la barra de espera; los controles siguen respondiendo.
 *   · `paramsVisibles`: los parámetros del DESTINO mientras está en vuelo, y
 *     los de la URL cuando no. Pestañas, chips, página y tamaño se dibujan a
 *     partir de esto, así que reflejan el click al instante y no cuando llega
 *     la respuesta.
 *
 * `useTransition` y no un `useState(cargando)` a mano: React mantiene la
 * pantalla vieja interactiva mientras prepara la nueva, y `isPending` se
 * apaga solo cuando la nueva se pintó — no hay forma de que quede prendido.
 *
 * Sin proveedor —otra pantalla que use los mismos hooks— todo sigue andando:
 * `empujar` es un `router.push` común y `pending` es siempre `false`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";

interface Navegacion {
  /** Hay una navegación en vuelo. */
  pending: boolean;
  /** Lo que la pantalla tiene que reflejar YA: el destino si hay uno, si no la URL. */
  paramsVisibles: URLSearchParams;
  /** Empuja una ruta dentro de la transición. */
  empujar: (url: string) => void;
}

const Ctx = createContext<Navegacion | null>(null);

export function NavegacionPendienteProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [destino, setDestino] = useState<URLSearchParams | null>(null);

  const empujar = useCallback(
    (url: string) => {
      const i = url.indexOf("?");
      setDestino(new URLSearchParams(i === -1 ? "" : url.slice(i + 1)));
      startTransition(() => {
        router.push(url);
      });
    },
    [router]
  );

  /*
   * El destino NO se limpia con un efecto: `paramsVisibles` sólo lo usa
   * mientras `isPending` es verdadero, así que un destino viejo que quede
   * guardado es inerte, y el próximo `empujar` lo pisa. Un
   * `useEffect(() => setDestino(null))` era la alternativa, y es exactamente
   * el patrón que la regla `set-state-in-effect` del repo prohíbe.
   */
  const value = useMemo<Navegacion>(
    () => ({
      pending: isPending,
      paramsVisibles: isPending && destino ? destino : searchParams,
      empujar,
    }),
    [isPending, destino, searchParams, empujar]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** La navegación de la bandeja; fuera del proveedor, un `router.push` común. */
export function useNavegacion(): Navegacion {
  const ctx = useContext(Ctx);
  const router = useRouter();
  const searchParams = useSearchParams();
  const empujarSimple = useCallback((url: string) => router.push(url), [router]);
  return (
    ctx ?? {
      pending: false,
      paramsVisibles: searchParams,
      empujar: empujarSimple,
    }
  );
}
