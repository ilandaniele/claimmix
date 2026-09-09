/**
 * poll-state.ts — system-actor DB access for gmail_poll_state
 *
 * The gmail_poll_state table is operational state owned by the cron/webhook
 * system paths — it has no tenant column and is never exposed to tenant users.
 *
 * AC7:  advancePollState() mueve la marca hasta donde se leyó, con mensajes
 *       fallados o sin ellos (ver `shouldAdvance` en gmail-poller.ts).
 * AC8:  recordPollError() escribe last_error y no toca history_id. Ojo: NO
 *       frena la marca — el que la mueve es advancePollState, que corre igual.
 * AC13: last_error es el rastro del mensaje que se perdió. advancePollState ya
 *       no lo borra; si lo volviera a borrar, no quedaría nada del mensaje.
 * AC2:  getWatchExpiration() returns null when no row exists or watch_expiration
 *       is null — safe sentinel for "watch never registered or already cleaned up".
 * AC3:  getWatchExpiration() returns the ISO timestamp string when set.
 */

import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gmailPollState } from "@/lib/db/schema";
import { firstRow } from "@/lib/db/helpers";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PollStateRow {
  id: string;
  historyId: string;
  /** Lo que quedó por reintentar de corridas anteriores. Migración 0026. */
  pendientes: MensajePendiente[];
}

/** Un mensaje que falló y hay que volver a leer. */
export interface MensajePendiente {
  id: string;
  intentos: number;
  /** ISO. Sólo para poder ver hace cuánto que uno viene fallando. */
  visto: string;
}

/**
 * Cuántas veces se reintenta un mensaje antes de soltarlo.
 *
 * No es infinito a propósito: un mensaje que falla por lo que es —un adjunto
 * corrupto, un MIME que la librería no parsea— fallaría en cada corrida para
 * siempre, y la lista crecería sin techo. Tres intentos cubren lo que se
 * arregla solo (un hipo de red, la base ocupada, un timeout del proveedor) sin
 * arrastrar para siempre lo que no.
 *
 * Al soltarlo se escribe un log con nivel `error` nombrando el id: es el único
 * momento en que un correo se da por perdido, y tiene que dejar rastro.
 */
export const MAX_INTENTOS_POR_MENSAJE = 3;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get the current poll state for the given Gmail account, creating a new row
 * with history_id='1' if none exists.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING + SELECT to avoid a race condition
 * between two concurrent cron invocations (Vercel guarantees at-most-once
 * delivery per schedule window, but defense-in-depth applies here).
 *
 * @param gmailEmail  The Gmail address being polled.
 * @returns { id, historyId } from the existing or newly created row.
 */
export async function getOrCreatePollState(
  gmailEmail: string
): Promise<PollStateRow> {
  // Attempt to insert a sentinel row; if one already exists the ON CONFLICT
  // DO NOTHING clause makes the insert a no-op (we do not want to reset
  // history_id). Conflict target: unique index idx_gmail_poll_state_account
  // on gmail_account_email.
  try {
    // sin-inquilino: `gmail_poll_state` no tiene columna de inquilino: es estado del
    // poller, uno por casilla, del sistema y no de un inquilino.
    await db
      .insert(gmailPollState)
      .values({ gmail_account_email: gmailEmail, history_id: "1" })
      .onConflictDoNothing({ target: [gmailPollState.gmail_account_email] });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "unknown";
    throw new Error(
      `[poll-state] Failed to initialise gmail_poll_state row: ${code}`
    );
  }

  // Always fetch the current row (whether just inserted or pre-existing).
  let data: { id: string; history_id: string; pendientes: MensajePendiente[] } | null;
  try {
    data = firstRow(
      // sin-inquilino: `gmail_poll_state` no tiene columna de inquilino: es estado del
      // poller, uno por casilla, del sistema y no de un inquilino.
      await db
        .select({
          id: gmailPollState.id,
          history_id: gmailPollState.history_id,
          pendientes: gmailPollState.mensajes_pendientes,
        })
        .from(gmailPollState)
        .where(eq(gmailPollState.gmail_account_email, gmailEmail))
        .limit(1)
    );
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "unknown";
    throw new Error(
      `[poll-state] Failed to read gmail_poll_state row: ${code}`
    );
  }

  if (!data) {
    throw new Error(
      `[poll-state] Failed to read gmail_poll_state row: no_data`
    );
  }

  return {
    id: data.id,
    historyId: data.history_id,
    // Una fila vieja, de antes de la 0026, puede traer null.
    pendientes: data.pendientes ?? [],
  };
}

/**
 * Avanza la marca después de una tanda.
 *
 * Pone history_id, last_polled_at y updated_at. NO toca last_error, a
 * propósito.
 *
 * La marca avanza aunque los mensajes hayan fallado —`shouldAdvance` en
 * `gmail-poller.ts`, y ahí está el porqué: quedarse clavada reintenta el
 * mismo mensaje venenoso en cada empuje de Pub/Sub y detrás de él no entra
 * ninguno más—. Mientras acá se borraba `last_error`, el mensaje que no
 * entró no dejaba ningún rastro: `recordPollError` lo escribía en el bucle
 * de mensajes y este UPDATE, en la MISMA corrida, lo borraba milisegundos
 * después. Lo único que quedaba era un `console.error` en los logs de
 * Vercel, que se van.
 *
 * Lo que sobrevive ahora es «el último error que vimos», no «hay un error
 * ahora»: nadie limpia el campo. Trae el gmail_message_id, que es con lo
 * que se vuelve a buscar el mensaje a mano. Si en una corrida fallan
 * varios, queda sólo el último, porque `recordPollError` pisa el campo.
 *
 * @param id            PK de la fila de gmail_poll_state.
 * @param newHistoryId  Hasta qué historyId se leyó en esta corrida.
 */
export async function advancePollState(
  id: string,
  newHistoryId: string
): Promise<void> {
  try {
    // sin-inquilino: `gmail_poll_state` no tiene columna de inquilino: es estado del
    // poller, uno por casilla, del sistema y no de un inquilino.
    await db
      .update(gmailPollState)
      .set({
        history_id: newHistoryId,
        last_polled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where(eq(gmailPollState.id, id));
  } catch (err) {
    // Log error code only — no PII (id is a UUID, not a Gmail address).
    const code = (err as { code?: string })?.code ?? "unknown";
    throw new Error(
      `[poll-state] Failed to advance watermark: ${code}`
    );
  }
}

/**
 * Guardar qué mensajes quedaron por reintentar.
 *
 * Se escribe la lista entera y no un delta: el poller ya la tiene armada en
 * memoria —los que siguen fallando con un intento más, menos los que entraron,
 * menos los que agotaron los intentos— y dos escrituras parciales sobre un
 * jsonb desde dos corridas simultáneas se pisarían de formas difíciles de
 * seguir.
 *
 * No tira: si esto falla, el poller ya hizo su trabajo y lo peor que pasa es
 * que un mensaje se reintente una vez de más. Tirar acá sí sería grave, porque
 * abortaría la corrida DESPUÉS de haber procesado mensajes.
 */
export async function guardarPendientes(
  id: string,
  pendientes: MensajePendiente[]
): Promise<void> {
  try {
    // sin-inquilino: `gmail_poll_state` no tiene columna de inquilino: es estado del
    // poller, uno por casilla, del sistema y no de un inquilino.
    await db
      .update(gmailPollState)
      .set({
        mensajes_pendientes: pendientes,
        updated_at: new Date().toISOString(),
      })
      .where(eq(gmailPollState.id, id));
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "unknown";
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "poll_state.no_se_pudieron_guardar_los_pendientes",
        error_code: code,
        cuantos: pendientes.length,
      })
    );
  }
}

/**
 * Record a non-fatal polling error without advancing the watermark.
 *
 * Updates last_error and updated_at but does NOT change history_id,
 * so the next cron run retries from the same position (AC8, AC13).
 *
 * The error string is truncated to 500 chars before storage to prevent
 * PII leakage from accidental stack traces in error messages.
 *
 * @param id        PK of the gmail_poll_state row.
 * @param error     Human-readable error description (will be truncated to 500 chars).
 */
export async function recordPollError(
  id: string,
  error: string
): Promise<void> {
  const truncated = error.slice(0, 500);

  try {
    // sin-inquilino: `gmail_poll_state` no tiene columna de inquilino: es estado del
    // poller, uno por casilla, del sistema y no de un inquilino.
    await db
      .update(gmailPollState)
      .set({
        last_error: truncated,
        updated_at: new Date().toISOString(),
      })
      .where(eq(gmailPollState.id, id));
  } catch (err) {
    // Non-fatal: log the code but do not throw — the cron should continue.
    const code = (err as { code?: string })?.code ?? "unknown";
    console.error("[poll-state] Failed to record poll error:", code); // crew-debug-ok
  }
}

/**
 * Get the watch_expiration for the given Gmail account.
 *
 * Returns the ISO timestamp string if a row exists and watch_expiration is set,
 * or null if the row is missing (no watch ever registered) or watch_expiration
 * is null (watch was not set up or was cleared).
 *
 * AC2: row missing          → null
 * AC2: row present, column null → null
 * AC3: row present, column set  → ISO string
 *
 * @param gmailEmail  The Gmail address to look up.
 * @returns ISO timestamp string or null.
 */
export async function getWatchExpiration(
  gmailEmail: string
): Promise<string | null> {
  let data: { watch_expiration: string | null } | null;
  try {
    data = firstRow(
      // sin-inquilino: `gmail_poll_state` no tiene columna de inquilino: es estado del
      // poller, uno por casilla, del sistema y no de un inquilino.
      await db
        .select({ watch_expiration: gmailPollState.watch_expiration })
        .from(gmailPollState)
        .where(eq(gmailPollState.gmail_account_email, gmailEmail))
        .limit(1)
    );
  } catch (err) {
    // Log code only — gmailEmail is PII-adjacent, do not log it.
    const code = (err as { code?: string })?.code ?? "unknown";
    throw new Error(
      `[poll-state] Failed to read watch_expiration: ${code}`
    );
  }

  // data is null when no row exists.
  if (!data || data.watch_expiration == null) {
    return null;
  }

  // watch_expiration is stored as timestamptz; the driver returns it as an
  // ISO-8601 string (timestamp mode "string").  Return it verbatim.
  return data.watch_expiration;
}

/**
 * Upsert the Gmail watch subscription state for the given account.
 *
 * Sets watch_expiration and watch_history_id, and bumps updated_at.
 * Uses the unique index on gmail_account_email to upsert safely.
 *
 * Called by setupGmailWatch() after a successful users.watch() API call (AC1).
 *
 * @param gmailEmail       The Gmail address whose watch was registered.
 * @param watchExpiration  ISO-8601 string when the watch expires.
 * @param watchHistoryId   historyId returned by users.watch().
 */
export async function setWatchState(
  gmailEmail: string,
  watchExpiration: string,
  watchHistoryId: string
): Promise<void> {
  try {
    // sin-inquilino: `gmail_poll_state` no tiene columna de inquilino: es estado del
    // poller, uno por casilla, del sistema y no de un inquilino.
    await db
      .insert(gmailPollState)
      .values({
        gmail_account_email: gmailEmail,
        watch_expiration: watchExpiration,
        watch_history_id: watchHistoryId,
        updated_at: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: [gmailPollState.gmail_account_email],
        set: {
          watch_expiration: watchExpiration,
          watch_history_id: watchHistoryId,
          updated_at: new Date().toISOString(),
        },
      });
  } catch (err) {
    // Log code only — no PII (gmailEmail is PII-adjacent).
    const code = (err as { code?: string })?.code ?? "unknown";
    throw new Error(
      `[poll-state] Failed to set watch state: ${code}`
    );
  }
}
