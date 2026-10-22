import type { Metadata } from "next";

import { getT, type TranslationKey } from "@/lib/i18n";
import { getAccountLocale } from "@/server/i18n/idioma-de-la-cuenta";

/**
 * El `generateMetadata` de una pantalla del panel: su nombre, en el idioma de la cuenta.
 * Sin esto todas las pestañas dicen lo mismo y el anunciador de rutas no avisa del cambio.
 */
export function tituloDePantalla(clave: TranslationKey) {
  return async (): Promise<Metadata> => ({ title: getT(await getAccountLocale())(clave) });
}
