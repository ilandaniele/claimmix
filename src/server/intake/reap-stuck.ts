import "server-only";

import { and, eq, inArray, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { cases } from "@/lib/db/schema";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

/**
 * Stuck-case reaper.
 *
 * Simulate / batch-simulate create a case in status `procesando`, then run the
 * AI agent inside a Vercel `after()` callback. When many cases are queued (a big
 * batch with inter-case delays), the function's wall-clock budget (maxDuration)
 * can be exceeded and the later `after()` callbacks are evicted before they run.
 * Those cases are left in `procesando` forever — the INSERT happened but the
 * agent never did.
 *
 * This reaper transitions any case that has been `procesando` longer than the
 * threshold to `escalado` (recoverable — admins/worker can re-analyze it), with
 * an audit trail. It is safe to run repeatedly and concurrently: the UPDATE is
 * guarded on the row still being `procesando`.
 *
 * The simulation throttle already excludes stale `procesando` cases from the
 * blocker count (so they don't wedge the queue); this reaper is the active
 * cleanup that gets the cases themselves unstuck.
 */

const DEFAULT_STUCK_AFTER_MS = 20 * 60_000; // 20 minutes
const MAX_STUCK_AFTER_MS = 2 * 60 * 60_000; // 2 hours
const DEFAULT_REAP_LIMIT = 200;

/** Minutes a case may sit in `procesando` before it is considered stuck. */
export function getStuckReapAfterMs(): number {
  const raw = Number(process.env.SIMULATE_STUCK_REAP_AFTER_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_STUCK_AFTER_MS;
  return Math.min(Math.floor(raw), MAX_STUCK_AFTER_MS);
}

export interface ReapResult {
  reaped: number;
  caseIds: string[];
}

/**
 * Find cases stuck in `procesando` past the threshold and escalate them.
 *
 * @param opts.tenantId    Limit to one tenant (opportunistic calls); omit for the global cron sweep.
 * @param opts.olderThanMs Override the staleness threshold (defaults to SIMULATE_STUCK_REAP_AFTER_MS).
 * @param opts.limit       Max cases to reap in one pass (default 200).
 */
export async function reapStuckProcessingCases(opts?: {
  tenantId?: string;
  olderThanMs?: number;
  limit?: number;
}): Promise<ReapResult> {
  const olderThanMs = opts?.olderThanMs ?? getStuckReapAfterMs();
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const limit = opts?.limit ?? DEFAULT_REAP_LIMIT;

  let stuck: Array<{ id: string; tenant_id: string }>;
  try {
    // sin-inquilino: Barrido de sistema: recorre los casos de TODOS los inquilinos, que
    // es para lo que existe. El cron no corre en nombre de ninguno.
    stuck = await db
      .select({ id: cases.id, tenant_id: cases.tenant_id })
      .from(cases)
      .where(
        and(
          eq(cases.status, "procesando"),
          lt(cases.created_at, cutoff),
          opts?.tenantId ? eq(cases.tenant_id, opts.tenantId) : undefined
        )
      )
      .limit(limit);
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "unknown";
    console.error("[reap-stuck] lookup failed:", code);
    return { reaped: 0, caseIds: [] };
  }

  if (stuck.length === 0) return { reaped: 0, caseIds: [] };

  const ids = stuck.map((s) => s.id);

  let reapedIds: string[];
  try {
    // Guard on status so a case that just finished between SELECT and UPDATE
    // is not clobbered back to escalado.
    // sin-inquilino: Idem: rescata las filas que encontró la consulta de arriba.
    const updated = await db
      .update(cases)
      .set({ status: "escalado", updated_at: sql`now()` })
      .where(and(inArray(cases.id, ids), eq(cases.status, "procesando")))
      .returning({ id: cases.id, tenant_id: cases.tenant_id });
    reapedIds = updated.map((r) => r.id);
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "unknown";
    console.error("[reap-stuck] update failed:", code);
    return { reaped: 0, caseIds: [] };
  }

  const tenantById = new Map(stuck.map((s) => [s.id, s.tenant_id]));
  await Promise.all(
    reapedIds.map((id) =>
      writeAuditLog({
        tenant_id: tenantById.get(id) ?? "unknown",
        actor_id: null,
        event_type: AuditEvent.CASE_STATUS_CHANGED,
        target_type: "case",
        target_id: id,
        payload: {
          new_status: "escalado",
          reason: "processing_timeout",
          stuck_after_ms: olderThanMs,
        },
      }).catch(() => undefined)
    )
  );

  if (reapedIds.length > 0) {
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "claimmix",
        msg: "reap_stuck.escalated",
        reaped: reapedIds.length,
        stuck_after_ms: olderThanMs,
      })
    );
  }

  return { reaped: reapedIds.length, caseIds: reapedIds };
}
