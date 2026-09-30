/**
 * ¿Se puede mostrar este resumen que escribió el modelo?
 *
 * El modelo resume a partir de texto ajeno: el mensaje del denunciante, un PDF,
 * una nota de voz. Lo que resume puede traer lo que el denunciante quiso que
 * dijera. Estas guardas descartan el resumen entero en vez de corregirlo: un
 * resumen que no se muestra es un hueco; uno que miente es un dato falso en la
 * ficha.
 *
 * Nacieron en el asistente (G12, `src/server/asistente/responder.ts`) y ahora
 * las usa también el worker para el resumen del caso y el de cada adjunto, y el
 * clasificador del mensaje tardío (B3).
 */

import { RE_CENTINELA } from "@/core/ai/sin-centinelas";
import { EMAIL_RE, PHONE_RE } from "@/core/text/contacto";

/** Corridas de 6 o más dígitos: DNI, teléfono, un monto. */
function digitosLargos(texto: string): string[] {
  return texto.match(/\d{6,}/g) ?? [];
}

/**
 * Deshace el punto o el espacio de miles ("5.000.000", "5 000 000") para que
 * un número agrupado no se cuele partido en corridas cortas y esquive
 * `digitosLargos`. No toca nada que no tenga esa forma de a-tres-en-tres.
 */
export function normalizarNumeros(t: string): string {
  return t.replace(/\d{1,3}(?:[.\s]\d{3})+/g, (m) => m.replace(/[.\s]/g, ""));
}

/** Los números largos (normalizados) de los datos estructurados: lo único que un resumen puede repetir. */
export function digitosConocidos(valores: readonly (string | null | undefined)[]): Set<string> {
  return new Set(valores.flatMap((v) => (v ? digitosLargos(normalizarNumeros(v)) : [])));
}

/**
 * Ningún número largo del resumen del modelo puede ser nuevo: tiene que
 * aparecer ya en algún campo estructurado (póliza o extraído). Es la defensa
 * contra el denunciante que escribe "ya me depositaron $50000000" en un
 * mensaje: ese monto vive en el texto libre, nunca en un campo, así que si el
 * modelo lo repite como dato del caso, el resumen entero se descarta. Los dos
 * lados se normalizan antes de comparar, para que "5.000.000" valga lo mismo
 * que "5000000".
 */
export function tieneNumeroInventado(resumen: string, conocidos: Set<string>): boolean {
  return digitosLargos(normalizarNumeros(resumen)).some((n) => !conocidos.has(n));
}

/**
 * Un monto con signo de moneda ($, ARS, USD, u$s) que el resumen afirma sin
 * que esos mismos dígitos estén en la póliza o en un campo extraído. Es una
 * segunda guarda, aparte de `tieneNumeroInventado`: acá alcanza con un monto
 * corto (por ejemplo "$500") para descartar el resumen, porque un monto nunca
 * es un dato del caso — es una afirmación que el prompt le prohíbe hacer.
 */
export function tieneMontoInventado(resumen: string, conocidos: Set<string>): boolean {
  const montos = normalizarNumeros(resumen).match(/(?:\$|u\$s|\b(?:ars|usd)\b)\s?\d[\d.\s]*/gi) ?? [];
  return montos.some((m) => {
    const digitos = m.replace(/\D/g, "");
    return digitos.length > 0 && !conocidos.has(digitos);
  });
}

/**
 * Las guardas del asistente: largo, centinelas, enlaces, números y montos.
 *
 * `montos` son importes que sí se pueden repetir aunque no estén en `valores`
 * (la estimación de cobertura, que no es un campo del caso). Van aparte porque
 * `digitosConocidos` sólo guarda corridas de 6 o más cifras y `tieneMontoInventado`
 * descarta cualquier monto con signo de moneda que no conozca, aunque sea de
 * 50.000: un importe corto legítimo se rechazaba.
 */
export function resumenValido(
  resumen: string,
  valores: readonly (string | null | undefined)[],
  tope = 1200,
  montos: readonly number[] = []
): boolean {
  const conocidos = digitosConocidos(valores);
  for (const monto of montos) conocidos.add(String(Math.trunc(monto)));
  return (
    resumen.length > 0 &&
    resumen.length <= tope &&
    !RE_CENTINELA.test(resumen) &&
    !/https?:\/\//i.test(resumen) &&
    !tieneNumeroInventado(resumen, conocidos) &&
    !tieneMontoInventado(resumen, conocidos)
  );
}

/** Una fecha dd/mm/aaaa tiene la forma de un teléfono para `PHONE_RE`. */
const FECHA_RE = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g;

/**
 * Lo mismo, y además sin un email ni un teléfono: el resumen que se guarda en
 * la ficha no es lugar para datos de contacto que el modelo copió del texto.
 */
export function esResumenSeguro(
  resumen: string,
  valores: readonly (string | null | undefined)[],
  tope = 1200
): boolean {
  return (
    resumenValido(resumen, valores, tope) &&
    resumen.search(EMAIL_RE) === -1 &&
    resumen.replace(FECHA_RE, "").search(PHONE_RE) === -1
  );
}
