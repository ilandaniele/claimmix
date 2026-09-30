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

import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { leerGracia } from "@/core/retencion";
import { ESTADOS_CERRADOS } from "@/core/case/fsm";
import { enTenantVarias, type TenantContext } from "@/data/scope";
import type { UserRow } from "@/lib/db/types";
import { adjuntosPorPurgar, cases, claimAttachments } from "@/lib/db/schema";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

/**
 * Quién borra: el id para la auditoría, el rol para saber qué le toca.
 *
 * `retencion` es el barrido de los cinco años: no es una persona, no tiene id ni
 * «lo suyo», y su alcance lo fija `antesDe` y no un rol.
 */
export type ActorDelBorrado =
  | Pick<UserRow, "id" | "role">
  | { id: null; role: "retencion" };

type Opciones = {
  /** Sólo lo cerrado antes de esta fecha. Lo pone la retención, nunca una persona. */
  antesDe?: Date;
};

/**
 * La condición de qué casos se borran, en UN solo lugar.
 *
 * La usan las dos sentencias del lote —la que encola los adjuntos y la que
 * borra—, y tienen que coincidir al caso: si una se armara con una condición y
 * la otra con otra parecida, la cola recibiría adjuntos de casos que siguen
 * vivos o dejaría afuera los de los que se borraron.
 *
 * Con `antesDe` el estado y la fecha de cierre se revalidan en el propio DELETE:
 * un caso que se reabrió entre que la retención lo listó y ahora (P8) ya no
 * coincide y no se borra.
 */
export function cualesBorra(ids: string[], actor: ActorDelBorrado, { antesDe }: Opciones = {}) {
  return and(
    inArray(cases.id, ids),
    actor.role === "analyst" ? eq(cases.assigned_to, actor.id) : undefined,
    antesDe ? cerradoAntesDe(antesDe) : undefined
  );
}

/**
 * Qué es un caso vencido para la retención: en un estado cerrado y con `closed_at`
 * anterior al corte. La usan el listado de la retención y el DELETE, que tiene que
 * volver a comprobarlo: si difirieran, se listaría lo que el borrado no toca o al
 * revés.
 */
export function cerradoAntesDe(corte: Date) {
  return and(inArray(cases.status, [...ESTADOS_CERRADOS]), lt(cases.closed_at, corte.toISOString()));
}

/**
 * Borra los casos indicados que pertenezcan al inquilino del contexto.
 *
 * ── Un analista sólo borra lo suyo ──────────────────────────────────────────
 *
 * `patchCase` no deja que un analista edite un caso que no tiene asignado: le
 * contesta 404, para no confirmarle siquiera que existe. Acá no había nada, así
 * que el mismo analista que no puede cambiarle el estado a un caso ajeno podía
 * BORRARLO, con sus mensajes, sus adjuntos y sus campos, y con cascada a nueve
 * tablas. La operación irreversible era la más permisiva de las dos.
 *
 * La condición va adentro del `where` y no en un chequeo previo, por lo mismo
 * que el inquilino: un id que no le toca sencillamente no coincide con ninguna
 * fila, y sale de la respuesta igual que uno de otra aseguradora. No hace falta
 * un SELECT de comprobación ni una respuesta distinta que diga «éste existe
 * pero no es tuyo».
 *
 * Los demás roles que llegan hasta acá —dueño, admin, especialista— borran
 * cualquier caso del inquilino, igual que editan cualquiera. `viewer` no llega:
 * lo frena la ruta.
 *
 * ── Los adjuntos de R2 ──────────────────────────────────────────────────────
 *
 * El borrado anota los `storage_path` de los adjuntos del caso en
 * `adjuntos_por_purgar`, en la misma transacción, y la purga diferida los borra
 * de R2 pasada la gracia (`PURGA_GRACIA_DIAS`). Un adjunto que otro caso todavía
 * usa no se borra: la purga lo comprueba al momento de purgar.
 *
 * La cola sólo se agrega, sin ON CONFLICT: si el objeto ya estaba anotado por
 * otro caso que lo compartía, entra otra fila y la purga obedece a la más nueva.
 * Ignorar el choque dejaba mandar a una fila vieja, cancelada o ya vencida, y el
 * rol de la aplicación no puede actualizarla para renovarla.
 *
 * @returns los ids efectivamente borrados. Un id que no existe —o que es de
 *   otra aseguradora, o de otro analista— no aparece, y eso no es un error: es
 *   la respuesta.
 */
export async function deleteCases(
  ctx: TenantContext,
  ids: string[],
  actor: ActorDelBorrado,
  opciones: Opciones = {}
): Promise<string[]> {
  if (ids.length === 0) return [];

  const cuales = cualesBorra(ids, actor, opciones);
  const dias = leerGracia(process.env);

  /*
   * Un solo lote, y el orden importa: primero se anotan los adjuntos y después
   * se borra el caso, porque el borrado los arrastra por cascada y ya no habría
   * de dónde leerlos. Es una transacción: si el DELETE falla, la cola no recibe
   * nada, y si sale bien, recibe justo los adjuntos de lo que se borró.
   *
   * Los objetos de R2 NO se borran acá. Se anotan con una gracia (`purgar_despues`)
   * y los borra la purga diferida, que puede cortarse, reintentarse y dejar
   * rastro; y mientras tanto un borrado por error todavía se puede recuperar
   * con un punto en el tiempo de la base sin quedarse con los archivos perdidos.
   */
  const [, borrados] = await enTenantVarias<
    [unknown, Array<{ id: string }>]
  >(ctx, (db) => [
    db.insert(adjuntosPorPurgar)
      .select((qb) =>
        qb
          .selectDistinctOn([claimAttachments.storage_path], {
            id: sql<string>`gen_random_uuid()`.as("id"),
            tenant_id: cases.tenant_id,
            case_id: cases.id,
            storage_path: sql<string>`${claimAttachments.storage_path}`.as("storage_path"),
            encolado_en: sql<string>`now()`.as("encolado_en"),
            purgar_despues: sql<string>`now() + make_interval(days => ${dias})`.as("purgar_despues"),
            purgado_en: sql<string | null>`null::timestamptz`.as("purgado_en"),
            intentos: sql<number>`0::smallint`.as("intentos"),
            ultimo_error: sql<string | null>`null::text`.as("ultimo_error"),
          })
          .from(claimAttachments)
          .innerJoin(cases, eq(cases.id, claimAttachments.case_id))
          .where(and(isNotNull(claimAttachments.storage_path), cuales))
      ),
    db.delete(cases).where(cuales).returning({ id: cases.id }),
  ]);

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
      actor_id: actor.id,
      event_type: AuditEvent.CASE_DELETED,
      target_type: "case",
      target_id: id,
      payload: {
        borrados_en_la_tanda: borrados.length,
        ...(actor.role === "retencion" ? { por_retencion: true } : {}),
      },
    });
  }

  return borrados.map((r) => r.id);
}
