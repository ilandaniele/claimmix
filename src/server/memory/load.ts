/**
 * Smart memory loader — recalls hints from claim_memory for a known sender.
 *
 * AC13: When a second email arrives from the same sender, claim_memory hints
 *       are injected into the extraction prompt so that absent or low-confidence
 *       fields can be filled from prior confirmed values.
 *
 * Security:
 *   - Queries are parameterized via the Supabase client (no raw SQL interpolation).
 *   - Sender email is NEVER written to stdout — only case_id and count.
 *   - last_used_at updated fire-and-forget (does not block the extraction path).
 *
 * PII: senderEmail is a PII field. It is used as a lookup key and never logged.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
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
 * @param supabase     - Supabase client (service-role or user-scoped; reads only).
 * @param tenantId     - UUID of the tenant.
 * @param senderEmail  - Sender's email address (PII — used as lookup key, not logged).
 * @param senderPhone  - Sender's phone number (PII — used as lookup key, not logged).
 * @param caseId       - Optional case UUID for the MEMORY_APPLIED audit log.
 */
export async function loadMemoryHints(
  supabase: SupabaseClient,
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
    // Build an OR filter for sender email / phone keys.
    // Supabase .or() accepts a PostgREST filter string.
    const conditions: string[] = [];
    if (senderEmail) {
      // Escape any single quotes in the email address for PostgREST safety.
      const escapedEmail = senderEmail.replace(/'/g, "''");
      conditions.push(`key.eq.${escapedEmail}`);
    }
    if (senderPhone) {
      const escapedPhone = senderPhone.replace(/'/g, "''");
      conditions.push(`key.eq.${escapedPhone}`);
    }

    const orFilter = conditions.join(",");

    const { data, error } = await (supabase as any)
      .from("claim_memory")
      .select(
        "id,memory_type,key,value,confidence,source,last_used_at"
      )
      .eq("tenant_id", tenantId)
      .in("memory_type", MEMORY_TYPES_TO_LOAD)
      .or(orFilter)
      .order("confidence", { ascending: false })
      .order("last_used_at", { ascending: false })
      .limit(MEMORY_LOAD_LIMIT);

    if (error) {
      console.error("[memory/load] claim_memory fetch error:", error.code);
      return [];
    }

    if (!data || data.length === 0) {
      return [];
    }

    const hints: MemoryHint[] = (data as Array<{
      id: string;
      memory_type: string;
      key: string;
      value: unknown;
      confidence: number;
      source: string;
    }>).map((row) => ({
      memoryType: row.memory_type,
      key: row.key,
      value: row.value,
      confidence: row.confidence,
      source: row.source,
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
      void updateLastUsedAt(
        supabase,
        (data as Array<{ id: string }>).map((r) => r.id)
      );
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
async function updateLastUsedAt(
  supabase: SupabaseClient,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  try {
    const { error } = await (supabase as any)
      .from("claim_memory")
      .update({ last_used_at: new Date().toISOString() })
      .in("id", ids);

    if (error) {
      console.error("[memory/load] last_used_at update error:", error.code);
    }
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    console.error("[memory/load] last_used_at update exception:", errName);
  }
}
