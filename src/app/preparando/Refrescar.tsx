"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const CADA_MS = 5_000;

/** Alguien está escribiendo el código, o un pedido del número va en camino: un refresco pisaría lo uno o la respuesta del otro. */
function hayAlgoAMedias(): boolean {
  const activo = document.activeElement;
  const escribiendo = activo instanceof HTMLInputElement || activo instanceof HTMLTextAreaElement;
  return escribiendo || document.querySelector('[aria-busy="true"]') !== null;
}

/** Vuelve a pedir la pantalla cada tanto: el servidor ve si la base ya está lista y redirige. No dibuja nada. */
export function Refrescar() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (!hayAlgoAMedias()) router.refresh();
    }, CADA_MS);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
