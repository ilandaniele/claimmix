/**
 * watch.ts — Gmail users.watch() setup for ClaimMix push notifications.
 *
 * setupGmailWatch() registers a Gmail push subscription for the configured
 * account, persists the resulting watch state to gmail_poll_state, and returns
 * the raw historyId and ISO expiration timestamp.
 *
 * AC1: setupGmailWatch calls gmail.users.watch, returns {historyId, expiration},
 *      and persists the watch state via setWatchState().
 *
 * stopGmailWatch() is the reverse: gmail.users.stop + clearWatchState(). Se usa
 * al deshabilitar una casilla, para que Google deje de mandar avisos de una
 * casilla que el poller ya no lee.
 *
 * Security:
 * - Topic name is NOT logged — it may encode environment or project identifiers.
 * - GMAIL_USER_EMAIL is NOT logged — it is PII-adjacent.
 * - On failure, only the HTTP status code or error code is logged.
 */

import "server-only";
import { getGmailClient } from "@/server/email/gmail/gmail-client";
import { clearWatchState, setWatchState } from "@/server/email/gmail/poll-state";
import { logger } from "@/lib/observability/logger";

export interface GmailWatchAccount {
  email: string;
  refreshToken?: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register a Gmail push subscription for the inbox of the configured account.
 *
 * Calls gmail.users.watch() with the supplied Pub/Sub topic name, converts the
 * millisecond-epoch expiration string returned by the API to an ISO-8601
 * timestamp, persists the watch state, and returns both values to the caller.
 *
 * @param topicName  Fully-qualified Pub/Sub topic name
 *                   (e.g. "projects/my-project/topics/gmail-push").
 * @returns { historyId, expiration } — historyId as returned by the API;
 *          expiration as an ISO-8601 string derived from the ms-epoch value.
 * @throws  If the API response is missing historyId or expiration, or if the
 *          DB upsert fails.
 */
export async function setupGmailWatch(
  topicName: string,
  account?: GmailWatchAccount
): Promise<{ historyId: string; expiration: string }> {
  // Validate env before making any API call to prevent orphaned watch subscriptions.
  const gmailEmail = account?.email ?? process.env.GMAIL_USER_EMAIL;
  if (!gmailEmail) {
    throw new Error("[watch] GMAIL_USER_EMAIL env var is not set");
  }

  const gmail = getGmailClient(account?.refreshToken);

  const response = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName,
      labelIds: ["INBOX"],
    },
  });

  const { historyId, expiration } = response.data;

  if (!historyId) {
    throw new Error("[watch] gmail.users.watch response missing historyId");
  }

  if (!expiration) {
    throw new Error("[watch] gmail.users.watch response missing expiration");
  }

  // expiration is a ms-since-epoch value returned as a string by the Gmail API
  // (e.g. "1750000000000"). Convert to ISO-8601 for consistent DB storage.
  const expirationIso = new Date(Number(expiration)).toISOString();

  await setWatchState(gmailEmail, expirationIso, historyId);

  return { historyId, expiration: expirationIso };
}

/**
 * Apaga el aviso de Gmail de una casilla y borra su marca de vencimiento.
 *
 * Idempotente: si Google contesta 404 o 400 es que no había watch (nunca se
 * registró, o ya venció o se revocó el permiso), y eso es lo que se quería
 * lograr. Se loguea y se sigue, borrando la marca igual. Cualquier otro error
 * —red, 401, 5xx— tira, porque el watch puede seguir vivo.
 */
export async function stopGmailWatch(account: GmailWatchAccount): Promise<void> {
  const gmail = getGmailClient(account.refreshToken);

  try {
    await gmail.users.stop({ userId: "me" });
  } catch (err: unknown) {
    const e = err as { status?: number; code?: number | string; response?: { status?: number } };
    const status = e?.status ?? e?.response?.status ?? e?.code;
    if (status !== 404 && status !== 400) throw err;
    logger.info({ status }, "gmail_watch.stop.sin_watch");
  }

  await clearWatchState(account.email);
}
