/**
 * Cómo abre un mensaje que le pide datos a alguien.
 *
 * Estaba escrita cuatro veces adentro de la plantilla de mail —HTML y texto,
 * por primera vuelta y vuelta posterior— y la única razón de las cuatro copias
 * era que la frase llevaba el número de caso adentro, con `<strong>` en una
 * versión y sin nada en la otra. El número ya está en el asunto, en el título y
 * en el pie: sacándolo, la frase es una sola y sirve para los dos renderizados.
 *
 * El defecto que esto arregla es más viejo que el refactor. La apertura era
 * `nombre ? nombre + ", " : ""` seguida de una frase en minúscula pensada para
 * venir detrás del nombre, así que sin nombre le llegaba a la persona un mail
 * que abría «gracias por tu reclamo.», descabezado. Un caso real de producción
 * (18:10 del 7 de septiembre) salió así.
 *
 * Devuelve TEXTO PLANO. La plantilla lo escapa al interpolarlo en HTML y lo usa
 * crudo en la versión `text`, que es la regla del resto del correo.
 */

export interface Apertura {
  /** El nombre de pila, cuando el caso ya lo tiene. */
  nombre?: string | null;
  /** Ya le escribimos antes por este caso. */
  esVuelta?: boolean;
}

export function apertura({ nombre, esVuelta }: Apertura): string {
  const quien = nombre?.trim();

  if (esVuelta) {
    return quien
      ? `${quien}, para poder seguir con tu reclamo nos falta:`
      : "Para poder seguir con tu reclamo nos falta:";
  }

  return quien
    ? `${quien}, gracias por tu reclamo. Para poder continuar necesitamos que nos proporciones la siguiente información:`
    : "Gracias por tu reclamo. Para poder continuar necesitamos que nos proporciones la siguiente información:";
}
