/**
 * Smart memory loader — recalls hints from claim_memory for a known sender.
 *
 * AC13: When a second email arrives from the same sender, claim_memory hints
 *       are injected into the extraction prompt so that absent or low-confidence
 *       fields can be filled from prior confirmed values.
 *
 * Security:
 *   - Queries are parameterized via Drizzle (no raw SQL interpolation).
 *   - Sender email is NEVER written to stdout — only case_id and count.
 *   - last_used_at updated fire-and-forget (does not block the extraction path).
 *
 * PII: senderEmail is a PII field. It is used as a lookup key and never logged.
 */

import "server-only";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single memory hint returned to the extraction worker.
 *
 * The `key` field is a lookup identifier (e.g. sender email or phone).
 * The `value` is the recalled data for that key.
 * `confidence` is the trust level assigned to this memory entry (0–1).
 * `source` describes how this hint was recorded ('human_confirmation' | 'auto_extracted').
 */
export interface MemoryHint {
  memoryType: string;
  key: string;
  value: unknown;
  confidence: number;
  source: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MEMORY_TYPES_TO_LOAD = [
  "sender_profile",
  "field_correction",
  "policy_link",
] as const;

const MEMORY_LOAD_LIMIT = 20;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load memory hints for a given sender.
 *
 * Queries claim_memory rows matching the sender's email or phone, ordered by
 * confidence desc, last_used_at desc. Updates last_used_at fire-and-forget.
 *
 * Returns an empty array if no sender identifiers are provided — this prevents
 * loading spam/noise hints for unknown senders.
 *
 * Logs MEMORY_APPLIED audit event (without PII) when hints are found.
 *
 * @param tenantId     - UUID of the tenant.
 * @param senderEmail  - Sender's email address (PII — used as lookup key, not logged).
 * @param senderPhone  - Sender's phone number (PII — used as lookup key, not logged).
 * @param caseId       - Optional case UUID for the MEMORY_APPLIED audit log.
 */
export async function loadMemoryHints(
  tenantId: string,
  senderEmail?: string,
  senderPhone?: string,
  caseId?: string
): Promise<MemoryHint[]> {
  // AC13: If no sender identifiers, return [] — no hints for unknown senders.
  if (!senderEmail && !senderPhone) {
    return [];
  }

  try {
    const t = tables.claimMemory;

    // Build an OR filter for sender email / phone keys (parameterized).
    const keyConditions = [];
    if (senderEmail) keyConditions.push(eq(t.key, senderEmail));
    if (senderPhone) keyConditions.push(eq(t.key, senderPhone));

    let data: Array<{
      id: string;
      memory_type: string;
      key: string;
      value: unknown;
      confidence: number | null;
      source: string | null;
      last_used_at: string | null;
    }>;
    try {
      data = await db
        .select({
          id: t.id,
          memory_type: t.memory_type,
          key: t.key,
          value: t.value,
          confidence: t.confidence,
          source: t.source,
          last_used_at: t.last_used_at,
        })
        .from(t)
        .where(
          and(
            eq(t.tenant_id, tenantId),
            inArray(t.memory_type, [...MEMORY_TYPES_TO_LOAD]),
            or(...keyConditions)
          )
        )
        .orderBy(desc(t.confidence), desc(t.last_used_at))
        .limit(MEMORY_LOAD_LIMIT);
    } catch (e) {
      console.error("[memory/load] claim_memory fetch error:", (e as { code?: string })?.code);
      return [];
    }

    if (data.length === 0) {
      return [];
    }

    const hints: MemoryHint[] = data.map((row) => ({
      memoryType: row.memory_type,
      key: row.key,
      value: row.value,
      confidence: row.confidence as number,
      source: row.source as string,
    }));

    // AC13: Log MEMORY_APPLIED audit event when hints were found.
    if (hints.length > 0) {
      console.info(
        JSON.stringify({
          level: "info",
          service: "claimmix",
          msg: "memory.hints_loaded",
          hint_count: hints.length,
          case_id: caseId ?? null,
          // PII: sender email is NOT logged here
        })
      );

      if (caseId && tenantId) {
        // Fire-and-forget audit log — does not block the extraction path.
        void writeAuditLog({
          tenant_id: tenantId,
          event_type: AuditEvent.MEMORY_APPLIED,
          target_type: "case",
          target_id: caseId,
          payload: {
            hint_count: hints.length,
            memory_types: [...new Set(hints.map((h) => h.memoryType))],
          },
        });
      }

      // Fire-and-forget: update last_used_at on fetched rows.
      void updateLastUsedAt(data.map((r) => r.id));
    }

    return hints;
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    console.error("[memory/load] exception:", errName);
    return [];
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Update last_used_at on the fetched memory rows.
 * Fire-and-forget — failures are logged but not propagated.
 */
async function updateLastUsedAt(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await db
      .update(tables.claimMemory)
      .set({ last_used_at: new Date().toISOString() })
      .where(inArray(tables.claimMemory.id, ids));
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    console.error("[memory/load] last_used_at update exception:", errName);
  }
}
