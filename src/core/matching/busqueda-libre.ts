/**
 * Qué está buscando alguien que escribió algo en la caja de `/clientes`.
 *
 * El placeholder dice, textual, «Buscar por nombre, DNI o email...», y la
 * consulta hacía `ilike(full_name, '%…%')` y nada más. Un especialista que
 * escribía el DNI del asegurado —que es el dato que tiene a mano cuando lo llama
 * por teléfono— recibía «no hay clientes», con la caja diciéndole que ese era
 * uno de los tres modos de buscar.
 *
 * Cero resultados es indistinguible de «esa persona no está en el padrón»: la
 * pantalla no falla, miente.
 *
 * Esto decide QUÉ es lo que escribieron. La consulta se arma en el servidor, con
 * el término ya normalizado.
 */

import { normalizarDni, normalizarEmail, sirveParaBuscar, MINIMO_DNI } from "./normalizar";

export interface TerminoDeBusqueda {
  /** El texto tal como lo escribieron, para buscar por nombre. */
  nombre: string;
  /** Los dígitos pelados, si lo que escribieron puede ser un documento. */
  dni: string | null;
  /** En minúsculas, si lo que escribieron parece una dirección. */
  email: string | null;
}

/**
 * Interpreta el término, sin decidir la consulta.
 *
 * Los tres modos NO son excluyentes a propósito: `27654321` es un DNI y también
 * podría ser parte de un nombre de fantasía, y la consulta los busca con OR. Lo
 * que importa es no descartar el modo que la caja promete.
 */
export function interpretarBusqueda(crudo: string): TerminoDeBusqueda | null {
  const termino = crudo.trim();
  if (termino.length === 0) return null;

  /*
   * Sólo cuenta como DNI si al sacarle la puntuación quedan suficientes
   * dígitos. Sin esa guarda, buscar «Ana» normaliza a la cadena vacía y una
   * comparación contra la columna de documento devolvería a toda persona con el
   * documento vacío: en vez de no encontrar a nadie, encontraríamos a
   * cualquiera. Es la misma guarda que usa el buscador de casos.
   */
  const dni = normalizarDni(termino);
  const pareceDni = sirveParaBuscar(dni, MINIMO_DNI);

  /*
   * Y sólo cuenta como correo si tiene arroba. `ilike '%ana%'` contra la columna
   * de correo ya lo cubre para las búsquedas parciales; esto es para cuando
   * pegan la dirección entera.
   */
  const email = termino.includes("@") ? normalizarEmail(termino) : "";

  return {
    nombre: termino,
    dni: pareceDni ? dni : null,
    email: email.length > 0 ? email : null,
  };
}
