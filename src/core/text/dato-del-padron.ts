/**
 * ¿La respuesta le dicta a la persona un dato que sólo sabemos por el padrón?
 *
 * El agente busca la póliza por el DNI que escribió quien nos escribe. Si
 * después el mensaje dice «encontramos tu póliza POL-8812-R», cualquiera que
 * escriba un DNI ajeno recibe de vuelta, por el canal que sea, el número de
 * contrato de otro. El dato queda en la denuncia —el worker lo completa en
 * `extracted_fields`—; lo que no puede hacer es salir en el texto.
 *
 * Sólo cuentan los datos con forma de identificador: un número largo o un
 * código con letras y dígitos. Una palabra del padrón («vigente», «auto») no
 * identifica a nadie, y filtrarlas rechazaría respuestas normales.
 */

import { soloAlfanumerico } from "@/core/case/respaldado-por-busqueda";

/** Una corrida de letras y números que puede llevar `-`, `_`, `.` o `/` adentro: `POL-8812-R`, `27.654.321`. */
const CANDIDATO = /[\p{L}\p{N}]+(?:[-_./][\p{L}\p{N}]+)*/gu;

const MIN_LARGO = 5;

/** Cuatro dígitos o más seguidos: la parte que distingue un contrato («8812» en `POL-8812-R`). */
const CORRIDA_DE_DIGITOS = /\d{4,}/g;

/** Una fecha no es una parte de contrato: su año («2026») está en cualquier respuesta. */
const FECHA = /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})/;

/**
 * Los identificadores que traen las consultas del agente, normalizados y sin repetir.
 *
 * Cada uno entra entero y también por sus corridas de cuatro dígitos o más:
 * «tu póliza termina en 8812» le dicta a quien escribió un DNI ajeno lo mismo
 * que «POL-8812-R», y el identificador entero no aparece en esa frase. Un
 * número suelto de cuatro dígitos («2015») no es un identificador y no cuenta.
 */
export function tokensDelPadron(fuentes: readonly string[]): string[] {
  const tokens = new Set<string>();
  for (const fuente of fuentes) {
    for (const [candidato] of fuente.matchAll(CANDIDATO)) {
      const token = soloAlfanumerico(candidato);
      if (token.length < MIN_LARGO) continue;
      const soloDigitos = /^\d+$/.test(token);
      const mezcla = /\d/.test(token) && /[a-záéíóúüñ]/.test(token);
      if (!soloDigitos && !mezcla) continue;
      tokens.add(token);
      if (FECHA.test(candidato)) continue;
      for (const [corrida] of candidato.matchAll(CORRIDA_DE_DIGITOS)) tokens.add(corrida);
    }
  }
  return [...tokens];
}

/**
 * El primer dato del padrón que el texto repite y que la persona no escribió.
 *
 * `permitidos` son los textos de los que sí puede venir: lo que escribió la
 * persona, lo que ya le mostramos enmascarado y el piso determinístico. Un
 * número que ella misma dijo se le puede confirmar; uno que sólo dio el padrón,
 * no.
 */
export function repiteDatoDelPadron(
  texto: string,
  tokens: readonly string[],
  permitidos: readonly string[]
): string | null {
  if (tokens.length === 0) return null;
  const normalizado = soloAlfanumerico(texto);
  const escrito = permitidos.map(soloAlfanumerico).join(" ");
  return tokens.find((t) => normalizado.includes(t) && !escrito.includes(t)) ?? null;
}
