/**
 * poll-state.ts — system-actor DB access for gmail_poll_state
 *
 * The gmail_poll_state table is operational state owned by the cron/webhook
 * system paths — it has no tenant column and is never exposed to tenant users.
 *
 * AC7:  Watermark advances only after all messages in a history batch succeed.
 * AC8:  recordPollError() updates last_error without advancing history_id,
 *       so the next cron run retries from the same watermark position.
 * AC13: advancePollState() is called only after a successful batch; a per-message
 *       error calls recordPollError() instead, leaving history_id unchanged.
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
}

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
  let data: { id: string; history_id: string } | null;
  try {
    data = firstRow(
      await db
        .select({ id: gmailPollState.id, history_id: gmailPollState.history_id })
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
  };
}

/**
 * Advance the watermark after a successful history batch.
 *
 * Sets history_id = newHistoryId, updated_at = now(), last_polled_at = now(),
 * and clears any previous last_error.
 *
 * MUST be called only after ALL messages in the batch have been successfully
 * processed (AC13 — per-message error isolation).
 *
 * @param id            PK of the gmail_poll_state row.
 * @param newHistoryId  The historyId returned by Gmail for this batch.
 */
export async function advancePollState(
  id: string,
  newHistoryId: string
): Promise<void> {
  try {
    await db
      .update(gmailPollState)
      .set({
        history_id: newHistoryId,
        last_polled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_error: null,
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
