/**
 * La huella de una dirección dentro de un espacio, calculada por la base: sha256
 * de `espacio:dirección` en minúsculas. Deja asentar «a esta dirección se la
 * borró» (`auth.user_deleted`) sin guardar el correo en el registro del espacio, y
 * volver a encontrarla al aceptar una invitación vieja.
 *
 * La arma el SQL de los dos lados (el borrado y la invitación) con esta misma
 * función: si cada uno normalizara a su manera, la huella no coincidiría nunca.
 */

import { sql, type SQL } from "drizzle-orm";

/** `correo` es una expresión SQL de texto: una columna (`u.email`) o un parámetro ya tipado. */
export function huellaDeCorreo(tenantId: string, correo: SQL): SQL {
  return sql`encode(sha256(convert_to(${tenantId}::text || ':' || lower(btrim(${correo})), 'utf8')), 'hex')`;
}
