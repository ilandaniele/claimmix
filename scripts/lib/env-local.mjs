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

import { readFileSync, writeFileSync } from "node:fs";

const NOMBRE_VALIDO = /^[A-Za-z_][A-Za-z0-9_]*$/;

function exigirNombre(nombre) {
  if (!NOMBRE_VALIDO.test(nombre)) {
    throw new Error(
      `"${nombre}" no es un nombre de variable de entorno: letras, dígitos y guiones bajos.`
    );
  }
}

/**
 * @param {string} nombre de la variable, p. ej. "STAGING_DATABASE_URL".
 * @param {string} [archivo] por si alguna vez no es `.env.local`.
 * @returns {string | null} el valor, o null si la variable no está.
 */
export function leerDeEnvLocal(nombre, archivo = "./.env.local") {
  exigirNombre(nombre);

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

/**
 * Pone (o reemplaza) una variable en `.env.local`, sin expresiones tampoco.
 *
 * `create-app-role` hacía `new RegExp(`^${CLAVE}=.*$`, "m")` para encontrar la
 * línea a pisar. Validar el nombre antes lo vuelve seguro, pero CodeQL sigue
 * marcándolo —`js/regex-injection` quiere escape, no validación— y tiene un
 * punto: mientras el patrón se arme con una variable, la seguridad depende de
 * que la guarda de arriba no se borre.
 *
 * Sin patrón no hay nada que romper. Se recorre línea por línea y se compara el
 * nombre, que es exactamente lo que hace `leerDeEnvLocal`: un solo lugar que
 * sabe cómo es el formato, para leer y para escribir.
 *
 * Conserva el final de línea del archivo. No imprime el valor: esto se usa para
 * guardar contraseñas.
 *
 * @param {string} nombre
 * @param {string} valor
 * @param {string} [archivo]
 */
export function escribirEnEnvLocal(nombre, valor, archivo = "./.env.local") {
  exigirNombre(nombre);

  let contenido = "";
  try {
    contenido = readFileSync(archivo, "utf8");
  } catch {
    // No está: se crea.
  }

  const salto = contenido.includes("\r\n") ? "\r\n" : "\n";
  const lineas = contenido.split(/\r?\n/);

  let puesta = false;
  const salida = lineas.map((linea) => {
    const igual = linea.indexOf("=");
    if (igual === -1) return linea;
    if (linea.slice(0, igual).trim() !== nombre) return linea;
    puesta = true;
    return `${nombre}=${valor}`;
  });

  if (!puesta) {
    while (salida.length > 0 && salida[salida.length - 1].trim() === "") salida.pop();
    salida.push("", `${nombre}=${valor}`, "");
  }

  writeFileSync(archivo, salida.join(salto), "utf8");
}
