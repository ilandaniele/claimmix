/**
 * Los dos parámetros que toda lista paginada recibe, escritos una sola vez.
 *
 * Estaban copiados en tres lugares —casos, clientes y pólizas— con el mismo
 * error en los tres: `per_page` tenía tope y `page` no. Con eso,
 * `?page=100000000` es un `OFFSET 2.500.000.000`, y Postgres NO puede saltear
 * filas sin leerlas: cuenta y descarta dos mil quinientos millones de veces
 * antes de devolver cero filas. Una sola petición, autenticada, dentro del
 * cupo, que se lleva la base puesta.
 *
 * El tope es de página, no de offset, porque es lo que la persona escribe. Mil
 * páginas por cien filas son cien mil filas: bastante más de lo que nadie
 * recorre a mano, y quien de verdad quiere todo tiene `export.csv`, que no
 * pagina.
 */

import { z } from "zod";

export const PAGINA_MAXIMA = 1000;
export const POR_PAGINA_MAXIMO = 100;

export const camposDePagina = {
  page: z.coerce.number().int().min(1).max(PAGINA_MAXIMA).default(1),
  per_page: z.coerce.number().int().min(1).max(POR_PAGINA_MAXIMO).default(25),
};
