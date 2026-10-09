"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

interface Props {
  className: string;
  children: ReactNode;
  name?: string;
  value?: string;
}

/**
 * El botón de un formulario del número de WhatsApp. Mientras el pedido va, se apaga
 * (un segundo clic gastaría otro SMS del cupo) y se marca `aria-busy`: `Refrescar` de
 * /preparando lo mira para no pisar la respuesta con un refresco. Va aparte porque
 * `useFormStatus` sólo lee el formulario que lo CONTIENE.
 */
export function BotonDeEnvio({ className, children, name, value }: Props) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name={name} value={value} disabled={pending} aria-busy={pending} className={className}>
      {children}
    </button>
  );
}
