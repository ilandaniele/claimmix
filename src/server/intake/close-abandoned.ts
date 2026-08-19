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
import { cases } from "@/lib/db/schema";
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
 * Close conversations that have gone quiet.
 *
 * Returns what it closed so the cron route can report it; failures are logged
 * and swallowed, since a sweep that throws would take the whole nightly run
 * with it.
 */
export async function closeAbandonedConversations(): Promise<CloseAbandonedResult> {
  const days = getAbandonAfterDays();

  try {
    const closed = await db
      .update(cases)
      .set({
        status: "cerrado",
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where(
        and(
          inArray(cases.status, [...AWAITING_CLAIMANT]),
          lt(
            sql`coalesce(${cases.updated_at}, ${cases.created_at})`,
            sql`now() - interval '${sql.raw(String(days))} days'`
          )
        )
      )
      .returning({ id: cases.id, tenant_id: cases.tenant_id });

    const capped = closed.slice(0, CLOSE_LIMIT);

    for (const row of capped) {
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
