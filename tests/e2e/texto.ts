/**
 * Buscar un texto de la interfaz sin apostar a un idioma.
 *
 * Los e2e buscaban los encabezados escritos a mano y en castellano —«cuentas
 * gmail de ingreso», «mensajes recibidos»—, y eso apuesta a algo que ningún
 * test fija: el idioma sale de `users.locale`, una preferencia por usuario
 * guardada en la base. Los e2e corren contra la base de staging, que es
 * compartida y sobrevive a los runs, así que alcanza con que alguien —una
 * persona mirando una pantalla, otro test— toque el selector de idioma una vez
 * para que el `PATCH /api/auth/me` deje esa cuenta en inglés para siempre.
 *
 * Desde ese momento el resultado depende de una carrera: `LocaleProvider`
 * escribe la cookie del idioma en un efecto, y `auth.setup.ts` guarda el
 * `storageState` apenas entra. Si el efecto llegó primero, la cookie queda en
 * inglés y las pantallas de servidor —que leen la cookie— salen en inglés; si
 * no, salen en castellano. El mismo commit pasa o falla según quién gane, que
 * es exactamente lo que se vio: 72 tests en verde a las 21:12 y el mismo test
 * en rojo a las 21:33, sin un cambio en el medio.
 *
 * Lo que el test quiere decir es «la sección de Gmail está en la pantalla», no
 * «la pantalla está en castellano». Entonces se busca por la CLAVE y se acepta
 * cualquiera de los dos idiomas.
 *
 * Si algún día hace falta afirmar el idioma, eso es otro test, y tiene que
 * fijarlo él mismo en vez de heredar el que haya quedado.
 */
import { esAR } from "../../src/lib/i18n/es-AR";
import { enUS } from "../../src/lib/i18n/en-US";
import type { TranslationKey } from "@/lib/i18n";

/** Escapa lo que en una regex significaría otra cosa (paréntesis, puntos). */
function literal(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Una regex que encuentra el texto de `clave` en cualquiera de los dos idiomas.
 *
 * @example page.getByRole("heading", { name: enCualquierIdioma("gmail.accounts.title") })
 */
export function enCualquierIdioma(clave: TranslationKey): RegExp {
  const variantes = [...new Set([esAR[clave], enUS[clave]])].map(literal);
  return new RegExp(variantes.join("|"), "i");
}
