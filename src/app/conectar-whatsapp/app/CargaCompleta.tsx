/**
 * Lleva a otra ruta con una carga completa del documento, no con una navegación del lado del cliente.
 *
 * Existe por la CSP: la que deja cargar el SDK de Meta se arma por pedido y sólo para /conectar-whatsapp
 * (`proxy.ts`), y un `redirect()` de servidor que llega por `router.refresh()` es un `router.replace`, que
 * conserva la CSP del documento de esta ruta, sin los orígenes de Facebook. Un `<a>` común sí pide el
 * documento de nuevo; el enlace queda a la vista por si el script no corre.
 */

"use client";

import { useEffect } from "react";

export function CargaCompleta({ destino, texto }: { destino: string; texto: string }) {
  useEffect(() => {
    window.location.replace(destino);
  }, [destino]);

  return (
    <a
      href={destino}
      className="inline-flex rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2"
    >
      {texto}
    </a>
  );
}
