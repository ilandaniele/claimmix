/**
 * Leer una variable de `.env.local`, sin armar una expresión con lo que venga
 * de la línea de comandos.
 *
 * Tres scripts hacían `new RegExp("^" + VAR + "\\s*=...")` con `VAR` sacado de
 * `--env`. CodeQL lo marca como `js/regex-injection` en severidad alta, y tiene
 * razón aunque el atacante sea uno mismo: `--env "A|.*"` deja de buscar una
 * variable y empieza a buscar cualquier línea, así que el script termina
 * conectándose a una base que nadie nombró. Es la clase de error que se ve
 * cuando ya se escribió.
 *
 * El nombre se valida antes de tocar nada. Un nombre de variable de entorno son
 * letras, dígitos y guiones bajos: cualquier otra cosa es un error de quien
 * llama, no un patrón.
 */

import { readFileSync } from "node:fs";

const NOMBRE_VALIDO = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @param {string} nombre de la variable, p. ej. "STAGING_DATABASE_URL".
 * @param {string} [archivo] por si alguna vez no es `.env.local`.
 * @returns {string | null} el valor, o null si la variable no está.
 */
export function leerDeEnvLocal(nombre, archivo = "./.env.local") {
  if (!NOMBRE_VALIDO.test(nombre)) {
    throw new Error(
      `"${nombre}" no es un nombre de variable de entorno: letras, dígitos y guiones bajos.`
    );
  }

  const texto = readFileSync(archivo, "utf8");
  for (const linea of texto.split(/\r?\n/)) {
    const igual = linea.indexOf("=");
    if (igual === -1) continue;
    if (linea.slice(0, igual).trim() !== nombre) continue;

    // Las comillas de los dos lados son del formato, no del valor.
    const valor = linea.slice(igual + 1).trim();
    return valor.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return null;
}
