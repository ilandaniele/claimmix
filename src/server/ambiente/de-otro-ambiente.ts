/**
 * Lo que este ambiente no tiene que tocar porque es del otro.
 *
 * prd y dev comparten la app de Meta, el cliente de Google y, hasta el move, las
 * direcciones públicas: un formulario impreso, un número de WhatsApp o una casilla
 * de dev que caen en prd se pierden sin dar ningún error. Cada lista viene del
 * entorno, separada por comas, y se compara sin blancos ni mayúsculas. Sin la
 * variable (dev, QA, local) la lista está vacía y nada de esto cambia nada.
 *
 *   SLUGS_DE_DEV             enlaces de /denuncia/<slug> que viven en dev;
 *   NUMEROS_DE_DEV           `phone_number_id` o E.164 de los números de dev;
 *   CASILLAS_DE_DEV          correos de las casillas Gmail de dev;
 *   URL_DEL_OTRO_AMBIENTE    dónde está dev, para mandar hacia allá a quien llegó acá.
 */

import "server-only";

import { mismoNumero } from "@/server/alta/validar";

function lista(crudo: string | undefined): string[] {
  return (crudo ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

export function esSlugDeOtroAmbiente(slug: string): boolean {
  return lista(process.env.SLUGS_DE_DEV).includes(slug.trim().toLowerCase());
}

/** El id de Meta o el número: la lista admite cualquiera de los dos, y «+549…» y «+54…» son el mismo número. */
export function esNumeroDeOtroAmbiente(phoneNumberId: string, e164?: string | null): boolean {
  const id = phoneNumberId.trim().toLowerCase();
  return lista(process.env.NUMEROS_DE_DEV).some((n) => n === id || (!!e164 && mismoNumero(n, e164)));
}

export function esCasillaDeOtroAmbiente(email: string): boolean {
  return lista(process.env.CASILLAS_DE_DEV).includes(email.trim().toLowerCase());
}

/** `ruta` en el otro ambiente, o null si no se dijo dónde está (o no es una URL http). */
export function urlDelOtroAmbiente(ruta = "/"): string | null {
  const base = process.env.URL_DEL_OTRO_AMBIENTE?.trim().replace(/\/+$/, "");
  return base && /^https?:\/\/[^/\s]/i.test(base) && URL.canParse(base) ? `${base}${ruta}` : null;
}
