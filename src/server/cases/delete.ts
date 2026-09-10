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
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

/**
 * Borra los casos indicados que pertenezcan al inquilino del contexto.
 *
 * @returns los ids efectivamente borrados. Un id que no existe —o que es de
 *   otra aseguradora— no aparece, y eso no es un error: es la respuesta.
 */
export async function deleteCases(
  ctx: TenantContext,
  ids: string[],
  /** Quién lo borró. Sin esto la fila de auditoría no sirve para nada. */
  actorId?: string | null
): Promise<string[]> {
  if (ids.length === 0) return [];

  const borrados = await enTenant<Array<{ id: string }>>(ctx, (db) =>
    db
      .delete(cases)
      .where(inArray(cases.id, ids))
      .returning({ id: cases.id })
  );

  /*
   * Que quede quién borró qué.
   *
   * Era la única operación irreversible del producto y la única sin registro:
   * un caso desaparecía con sus mensajes, sus adjuntos y sus campos, y no
   * quedaba nada que dijera quién lo hizo ni cuándo.
   *
   * Va DESPUÉS del borrado, no antes: anotar lo que todavía no pasó es cómo se
   * termina con una auditoría de cosas que fallaron. Y `target_id` no es clave
   * foránea —el esquema lo dice— así que la fila sobrevive a la que describe.
   *
   * Una por caso y no una por tanda: el que después busca «qué pasó con este
   * siniestro» busca por id, y un evento con cien ids adentro no aparece.
   */
  for (const { id } of borrados) {
    await writeAuditLog({
      tenant_id: ctx.tenantId,
      actor_id: actorId ?? null,
      event_type: AuditEvent.CASE_DELETED,
      target_type: "case",
      target_id: id,
      payload: { borrados_en_la_tanda: borrados.length },
    });
  }

  return borrados.map((r) => r.id);
}
