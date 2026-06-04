/**
 * poll-state.ts — service-role DB access for gmail_poll_state
 *
 * All functions require the service-role Supabase client (bypasses RLS).
 * The gmail_poll_state table has RLS ENABLED with no tenant-user policies;
 * only the service-role client (used by the cron route) may read or write it.
 *
 * AC7:  Watermark advances only after all messages in a history batch succeed.
 * AC8:  recordPollError() updates last_error without advancing history_id,
 *       so the next cron run retries from the same watermark position.
 * AC13: advancePollState() is called only after a successful batch; a per-message
 *       error calls recordPollError() instead, leaving history_id unchanged.
 * AC2:  getWatchExpiration() returns null when no row exists or watch_expiration
 *       is null — safe sentinel for "watch never registered or already cleaned up".
 * AC3:  getWatchExpiration() returns the ISO timestamp string when set.
 *
 * Pattern: mirrors createStorageClient() from claim-attachments-bucket.ts —
 * accepts an injected SupabaseClient so callers (and tests) control the client
 * lifecycle. No module-level singleton.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

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
 * @param supabase  Service-role Supabase client (bypasses RLS).
 * @param gmailEmail  The Gmail address being polled.
 * @returns { id, historyId } from the existing or newly created row.
 */
export async function getOrCreatePollState(
  supabase: SupabaseClient,
  gmailEmail: string
): Promise<PollStateRow> {
  // Attempt to insert a sentinel row; if one already exists the ON CONFLICT
  // clause causes the insert to be a no-op (ignoredByUpsert=true).
  const { error: insertError } = await supabase
    .from("gmail_poll_state")
    .insert({ gmail_account_email: gmailEmail, history_id: "1" })
    .select()
    // onConflict: do nothing (not upsert — we do not want to reset history_id)
    // Supabase JS v2: pass `{ ignoreDuplicates: true }` to the insert call.
    // We use a direct upsert approach with update no-op instead:
    // See below — simpler to do a select-then-insert pattern.
    ;

  // Ignore unique-constraint conflicts (code "23505") — the row already exists.
  if (insertError && insertError.code !== "23505") {
    throw new Error(
      `[poll-state] Failed to initialise gmail_poll_state row: ${insertError.code}`
    );
  }

  // Always fetch the current row (whether just inserted or pre-existing).
  const { data, error: selectError } = await supabase
    .from("gmail_poll_state")
    .select("id, history_id")
    .eq("gmail_account_email", gmailEmail)
    .single();

  if (selectError || !data) {
    throw new Error(
      `[poll-state] Failed to read gmail_poll_state row: ${selectError?.code ?? "no_data"}`
    );
  }

  return {
    id: data.id as string,
    historyId: data.history_id as string,
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
 * @param supabase      Service-role Supabase client.
 * @param id            PK of the gmail_poll_state row.
 * @param newHistoryId  The historyId returned by Gmail for this batch.
 */
export async function advancePollState(
  supabase: SupabaseClient,
  id: string,
  newHistoryId: string
): Promise<void> {
  const { error } = await supabase
    .from("gmail_poll_state")
    .update({
      history_id: newHistoryId,
      last_polled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", id);

  if (error) {
    // Log error code only — no PII (id is a UUID, not a Gmail address).
    throw new Error(
      `[poll-state] Failed to advance watermark: ${error.code}`
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
 * @param supabase  Service-role Supabase client.
 * @param id        PK of the gmail_poll_state row.
 * @param error     Human-readable error description (will be truncated to 500 chars).
 */
export async function recordPollError(
  supabase: SupabaseClient,
  id: string,
  error: string
): Promise<void> {
  const truncated = error.slice(0, 500);

  const { error: dbError } = await supabase
    .from("gmail_poll_state")
    .update({
      last_error: truncated,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (dbError) {
    // Non-fatal: log the code but do not throw — the cron should continue.
    console.error("[poll-state] Failed to record poll error:", dbError.code); // crew-debug-ok
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
 * @param supabase    Service-role Supabase client (bypasses RLS).
 * @param gmailEmail  The Gmail address to look up.
 * @returns ISO timestamp string or null.
 */
export async function getWatchExpiration(
  supabase: SupabaseClient,
  gmailEmail: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("gmail_poll_state")
    .select("watch_expiration")
    .eq("gmail_account_email", gmailEmail)
    .maybeSingle();

  if (error) {
    // Log code only — gmailEmail is PII-adjacent, do not log it.
    throw new Error(
      `[poll-state] Failed to read watch_expiration: ${error.code}`
    );
  }

  // data is null when no row exists (maybeSingle returns null instead of error).
  if (!data || data.watch_expiration == null) {
    return null;
  }

  // watch_expiration is stored as timestamptz; Supabase JS returns it as an
  // ISO-8601 string.  Return it verbatim.
  return data.watch_expiration as string;
}

/**
 * Upsert the Gmail watch subscription state for the given account.
 *
 * Sets watch_expiration and watch_history_id, and bumps updated_at.
 * Uses the unique index on gmail_account_email to upsert safely.
 *
 * Called by setupGmailWatch() after a successful users.watch() API call (AC1).
 *
 * @param supabase         Service-role Supabase client.
 * @param gmailEmail       The Gmail address whose watch was registered.
 * @param watchExpiration  ISO-8601 string when the watch expires.
 * @param watchHistoryId   historyId returned by users.watch().
 */
export async function setWatchState(
  supabase: SupabaseClient,
  gmailEmail: string,
  watchExpiration: string,
  watchHistoryId: string
): Promise<void> {
  const { error } = await supabase
    .from("gmail_poll_state")
    .upsert(
      {
        gmail_account_email: gmailEmail,
        watch_expiration: watchExpiration,
        watch_history_id: watchHistoryId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "gmail_account_email" }
    );

  if (error) {
    // Log code only — no PII (gmailEmail is PII-adjacent).
    throw new Error(
      `[poll-state] Failed to set watch state: ${error.code}`
    );
  }
}
