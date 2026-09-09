/**
 * Closing conversations nobody is having any more.
 *
 * The agent asks for a policy number, the person never answers, and the case
 * waits forever. Nineteen of them piled up in a single day of testing and had
 * to be closed by hand — in production that board stops being readable inside
 * a week, and on WhatsApp an abandoned case also holds that phone number's
 * thread hostage.
 *
 * Only conversations, never claims. A case is closed here when WE are the ones
 * waiting and the silence has gone on too long. A case in `listo_para_core` is
 * not abandoned — it is complete and waiting on the insurer, and marking it
 * closed would hide unfinished work behind a tidy board. `requiere_especialista`
 * is likewise somebody's job, not a stalled conversation.
 *
 * Idempotent and safe to run repeatedly: every UPDATE is guarded on the row
 * still being in the status that made it eligible.
 */

import "server-only";

import { and, inArray, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { cases, outboundMessages } from "@/lib/db/schema";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

/**
 * The statuses that mean "we asked, they have not answered".
 *
 * Both are states the agent itself sets after writing to the claimant, so
 * silence in them is genuinely the claimant's silence.
 */
const AWAITING_CLAIMANT = ["info_faltante", "confirmacion_pendiente"] as const;

const DEFAULT_ABANDON_AFTER_DAYS = 14;
const MAX_ABANDON_AFTER_DAYS = 90;
const CLOSE_LIMIT = 200;

/**
 * How long to wait before giving up on an answer.
 *
 * Two weeks is a judgement call: long enough that a person on holiday or
 * waiting for a police report still finds their case open, short enough that
 * the board reflects work anyone is actually doing. Configurable because the
 * right number belongs to whoever runs the operation, not to this file.
 */
export function getAbandonAfterDays(): number {
  const raw = Number(process.env.CONVERSATION_ABANDON_AFTER_DAYS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ABANDON_AFTER_DAYS;
  return Math.min(Math.floor(raw), MAX_ABANDON_AFTER_DAYS);
}

export interface CloseAbandonedResult {
  closed: number;
  caseIds: string[];
}

/**
 * ¿Llegamos a preguntar?
 *
 * El barrido cierra por silencio y anota «sin respuesta del denunciante». Pero
 * el silencio de alguien a quien nunca le preguntamos no es una respuesta que
 * falta: es un mensaje nuestro que no salió.
 *
 * Y salir del `info_faltante` no depende de que el envío haya funcionado. El
 * orquestador llama al mensajero y en la línea siguiente escribe el estado, sin
 * mirar el resultado. Un mail rechazado, una plantilla de WhatsApp fuera de la
 * ventana de 24 h, y el caso queda igual esperando una pregunta que nunca
 * llegó. Catorce días después se cerraba culpando a la persona.
 *
 * `outbound_messages` es el libro de los dos canales: lo escribe el despacho de
 * correo y lo escribe el mensajero de WhatsApp. Mira el ÚLTIMO, que es el que
 * habría pedido la respuesta que estamos esperando — con uno viejo que sí salió
 * alcanzaba para cerrar un caso cuya última pregunta se cayó.
 *
 * `skipped_simulated` cuenta como alcanzado a propósito: en una simulación el
 * mensaje hizo exactamente lo que tenía que hacer. Dejarlas afuera devolvería
 * el problema que este barrido existe para resolver — diecinueve casos a medias
 * en una tarde de pruebas, cerrados a mano.
 */
const leLlegoLaPregunta = sql`coalesce((
  select ${outboundMessages.status}
    from ${outboundMessages}
   where ${outboundMessages.case_id} = ${cases.id}
   order by ${outboundMessages.created_at} desc
   limit 1
) in ('sent', 'skipped_simulated'), false)`;

/**
 * Close conversations that have gone quiet.
 *
 * Returns what it closed so the cron route can report it; failures are logged
 * and swallowed, since a sweep that throws would take the whole nightly run
 * with it.
 */
export async function closeAbandonedConversations(): Promise<CloseAbandonedResult> {
  const days = getAbandonAfterDays();

  try {
    // sin-inquilino: Barrido de sistema: recorre los casos de TODOS los inquilinos, que
    // es para lo que existe. El cron no corre en nombre de ninguno.
    const closed = await db
      .update(cases)
      .set({
        status: "cerrado",
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      /*
       * El tope va DENTRO del UPDATE, no sobre lo que devuelve.
       *
       * Estaba abajo, como `closed.slice(0, CLOSE_LIMIT)`: el UPDATE cerraba
       * TODOS los casos elegibles y después se auditaban los primeros 200. Con
       * 250 elegibles —una cartera vieja con conversaciones a medias, o el cron
       * que no corrió unos días— quedaban 50 casos en `cerrado` sin una sola
       * línea en la auditoría. Un analista abre uno de esos, ve que se cerró
       * solo, y no hay nada que le diga por qué ni cuándo.
       *
       * Ahora se cierra exactamente lo que se va a auditar, y lo que sobra
       * queda para la corrida siguiente. Es el mismo principio que la marca de
       * agua del poller de Gmail: no avanzar más allá de lo que se procesó.
       */
      /*
       * El estado va TAMBIÉN acá, no sólo adentro de la subconsulta.
       *
       * El encabezado de este archivo promete que «every UPDATE is guarded on
       * the row still being in the status that made it eligible», y no lo
       * estaba: el predicado vivía sólo en el `IN`. Bajo READ COMMITTED,
       * cuando el UPDATE encuentra una fila que alguien modificó mientras
       * tanto, lo único que puede volver a evaluar es «el id sigue en el
       * conjunto» — y el id no cambia nunca.
       *
       * El caso: alguien contesta después de catorce días de silencio, que es
       * justo la población que este barrido apunta. El webhook guarda el
       * mensaje, el agente corre y escribe `listo_para_core`, y el cron —con
       * su foto vieja— lo pisa con `cerrado` y le estampa la fecha. Es
       * exactamente lo que las primeras líneas dicen que no puede pasar.
       *
       * `reap-stuck` lo hace bien desde siempre. Este no.
       */
      .where(
        and(
          inArray(cases.status, [...AWAITING_CLAIMANT]),
          inArray(
            cases.id,
            // sin-inquilino: la subconsulta que elige QUÉ cerrar, del mismo barrido
            // de sistema que el UPDATE que la contiene. No se ejecuta sola.
            db
              .select({ id: cases.id })
              .from(cases)
              .where(
                and(
                  inArray(cases.status, [...AWAITING_CLAIMANT]),
                  lt(
                    sql`coalesce(${cases.updated_at}, ${cases.created_at})`,
                    sql`now() - interval '${sql.raw(String(days))} days'`
                  ),
                  leLlegoLaPregunta
                )
              )
              .limit(CLOSE_LIMIT)
          )
        )
      )
      .returning({ id: cases.id, tenant_id: cases.tenant_id });

    for (const row of closed) {
      await writeAuditLog({
        tenant_id: row.tenant_id,
        actor_id: null,
        event_type: AuditEvent.CASE_CLOSED_ABANDONED,
        target_type: "case",
        target_id: row.id,
        payload: { after_days: days, reason: "sin respuesta del denunciante" },
      });
    }

    if (closed.length > 0) {
      console.info(
        JSON.stringify({
          level: "info",
          service: "claimmix",
          msg: "close_abandoned.swept",
          closed: closed.length,
          after_days: days,
        })
      );
    }

    /*
     * Y los que se quedaron abiertos porque el mensaje no salió.
     *
     * Antes se cerraban acá arriba y no había nada más que decir. Ahora se
     * quedan en el tablero, que es donde tienen que estar: lo que corresponde
     * es volver a mandar la pregunta, no dar la conversación por terminada.
     *
     * Pero quedarse callado los vuelve invisibles otra vez, con la diferencia
     * de que ahora encima no se cierran. Se cuentan, con sus ids, una línea por
     * barrido. Si esto sale con un número grande, no es que la gente no
     * conteste: es que no estamos preguntando.
     */
    await avisarDeLosQueNoRecibieron(days);

    return { closed: closed.length, caseIds: closed.map((r) => r.id) };
  } catch (err) {
    const code =
      (err as { code?: string })?.code ??
      (err instanceof Error ? err.name : "UnknownError");
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "close_abandoned.failed",
        code,
      })
    );
    return { closed: 0, caseIds: [] };
  }
}

/** Exported for the FSM and tests: the statuses this sweep is allowed to close. */
export const ABANDONABLE_STATUSES = AWAITING_CLAIMANT;

/**
 * Cuenta los casos vencidos a los que nunca les llegó la pregunta.
 *
 * Aparte del UPDATE y no adentro: son los que NO se tocan, así que no hay nada
 * que devolver de la escritura. Y va en su propio `try` porque es un aviso — si
 * falla no puede llevarse puesto un barrido que ya cerró lo que tenía que
 * cerrar.
 */
async function avisarDeLosQueNoRecibieron(days: number): Promise<void> {
  try {
    // sin-inquilino: el mismo barrido de sistema de arriba, mirando lo que dejó abierto.
    const retenidos = await db
      .select({ id: cases.id })
      .from(cases)
      .where(
        and(
          inArray(cases.status, [...AWAITING_CLAIMANT]),
          lt(
            sql`coalesce(${cases.updated_at}, ${cases.created_at})`,
            sql`now() - interval '${sql.raw(String(days))} days'`
          ),
          sql`not ${leLlegoLaPregunta}`
        )
      )
      .limit(CLOSE_LIMIT);

    if (retenidos.length === 0) return;

    console.warn(
      JSON.stringify({
        level: "warn",
        service: "claimmix",
        msg: "close_abandoned.sin_preguntar",
        casos: retenidos.length,
        after_days: days,
        case_ids: retenidos.map((r) => r.id),
        nota:
          "Vencidos y sin cerrar: el último mensaje al denunciante no salió. " +
          "No es silencio de la persona, es una pregunta que no llegó.",
      })
    );
  } catch (err) {
    const code =
      (err as { code?: string })?.code ??
      (err instanceof Error ? err.name : "UnknownError");
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "close_abandoned.aviso_fallo",
        code,
      })
    );
  }
}
