/**
 * Borrar casos, de a muchos, en una sola transacción.
 *
 * La bandeja permite seleccionar toda la página y borrar. Eso mandaba un pedido
 * HTTP por caso: hasta cien requests, y cada uno pagando de nuevo la sesión, la
 * consulta a `users` de la guarda, el contador del límite de tráfico, un SELECT
 * de comprobación y recién después el DELETE.
 *
 * No era sólo lento. Tres cosas lo volvían un bug y no una queja de estilo:
 *
 *   · El cupo de la API es de cien por minuto, así que borrar una página de cien
 *     se lo comía entero y, con cualquier borrado previo en ese minuto, parte de
 *     la tanda volvía 429 y el usuario veía un fallo a medias.
 *   · El limitador es un upsert sobre la misma fila `(clave, ventana)`, así que
 *     los cien pedidos se serializaban por lock: el paralelismo era aparente.
 *   · `cases` cascadea a nueve tablas hijas. Cien transacciones sueltas
 *     significan que una falla a la mitad deja borrado un subconjunto
 *     arbitrario, sin forma de saber cuál.
 *
 * El SELECT de comprobación previo tampoco hace falta acá: la restricción por
 * inquilino la pone la base con el contexto del lote, así que un id de otra
 * aseguradora sencillamente no coincide con ninguna fila. Se devuelve lo que
 * REALMENTE se borró, y quien llama compara contra lo que pidió.
 */

import "server-only";

import { inArray } from "drizzle-orm";

import { enTenant, type TenantContext } from "@/data/scope";
import { cases } from "@/lib/db/schema";

/**
 * Borra los casos indicados que pertenezcan al inquilino del contexto.
 *
 * @returns los ids efectivamente borrados. Un id que no existe —o que es de
 *   otra aseguradora— no aparece, y eso no es un error: es la respuesta.
 */
export async function deleteCases(
  ctx: TenantContext,
  ids: string[]
): Promise<string[]> {
  if (ids.length === 0) return [];

  const borrados = await enTenant<Array<{ id: string }>>(ctx, (db) =>
    db
      .delete(cases)
      .where(inArray(cases.id, ids))
      .returning({ id: cases.id })
  );

  return borrados.map((r) => r.id);
}
