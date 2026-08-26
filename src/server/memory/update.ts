/**
 * Smart memory updater — writes / upserts entries in claim_memory.
 *
 * AC14: Memory is ONLY updated after explicit human confirmation via
 *       PATCH /api/cases/:id/confirm-field. This module is never called
 *       from the extraction worker directly — only from the confirm-field handler.
 *
 * AC21: Every memory update is logged via audit_log with redacted values.
 *
 * Security / PII:
 *   - Sender email is the lookup key and never written to stdout.
 *   - All audit payloads go through redactObject() before logging.
 *   - Writes go through the shared Drizzle db client (tenant filter always applied).
 */

import "server-only";
import { and, eq } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { redactObject } from "@/lib/audit/redact";
import type { ExtractedField } from "@/lib/schemas/extracted-claim";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum confidence for extraction to be seeded into memory (IC9). */
const SEED_MIN_CONFIDENCE = 0.85;

/** Discount factor applied to auto-seeded memory confidence values. */
const SEED_CONFIDENCE_DISCOUNT = 0.8;

/** Confirmed confidence for human-confirmed memory entries. */
const CONFIRMATION_CONFIDENCE = 0.90;

/**
 * Fields that MAY be seeded into sender_profile memory.
 * Phone and email are lookup keys — never seeded as values.
 */
const SEEDABLE_FIELDS = ["full_name", "dni", "policy_number"] as const;
type SeedableField = (typeof SEEDABLE_FIELDS)[number];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Update claim_memory after a human analyst explicitly confirms a field value.
 *
 * UPSERTS a row with memory_type='field_correction', key=senderEmail.
 * If an existing row exists for (tenant_id, memory_type, key), its value JSON
 * is merged to set the confirmed field; confidence and use_count are updated.
 *
 * AC14: This function is ONLY called after explicit human confirmation — never
 *       from the extraction worker or any automatic path.
 * AC21: Logs FIELD_CONFIRMED audit event with redacted old/new values.
 *
 * @param tenantId       - UUID of the tenant.
 * @param fieldName      - The field key being confirmed (e.g. 'full_name').
 * @param confirmedValue - The analyst-confirmed value for the field.
 * @param senderEmail    - Sender's email address (lookup key — PII, never logged).
 * @param caseId         - UUID of the case (for audit log).
 * @param actorId        - UUID of the analyst performing the confirmation.
 * @param oldValue       - Previous value (for audit trail, will be redacted).
 */
export async function updateMemoryFromConfirmation(
  tenantId: string,
  fieldName: string,
  confirmedValue: string,
  senderEmail: string,
  caseId: string,
  actorId?: string,
  oldValue?: string
): Promise<void> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const now = new Date().toISOString();
    const t = tables.claimMemory;

    // ── 1. Fetch existing row (if any) ────────────────────────────────────────
    let existing: { id: string; value: unknown; use_count: number } | null = null;
    try {
      existing = firstRow(
        await enTenant(tenantCtx, (db) =>
          db
            .select({ id: t.id, value: t.value, use_count: t.use_count })
            .from(t)
            .where(
              and(
                eq(t.memory_type, "field_correction"),
                eq(t.key, senderEmail)
              )
            )
            .limit(1)
        )
      );
    } catch (e) {
      console.error("[memory/update] fetch error:", (e as { code?: string })?.code);
      // Continue — we'll still attempt the upsert.
    }

    // ── 2. Merge new field value into existing value JSON ─────────────────────
    const existingValue =
      existing?.value && typeof existing.value === "object"
        ? (existing.value as Record<string, unknown>)
        : {};

    const updatedValue: Record<string, unknown> = {
      ...existingValue,
      [fieldName]: confirmedValue,
    };

    const useCount = (existing?.use_count ?? 0) + 1;

    // ── 3. Upsert into claim_memory ───────────────────────────────────────────
    // Unique key: idx_claim_memory_tenant_type_key (tenant_id, memory_type, key).
    try {
      await enTenant(tenantCtx, (db) =>
        db
          .insert(t)
          .values({
            tenant_id: tenantId,
            memory_type: "field_correction",
            key: senderEmail,
            value: updatedValue,
            confidence: CONFIRMATION_CONFIDENCE,
            source: "human_confirmation",
            use_count: useCount,
            last_used_at: now,
          })
          .onConflictDoUpdate({
            target: [t.tenant_id, t.memory_type, t.key],
            set: {
              value: updatedValue,
              confidence: CONFIRMATION_CONFIDENCE,
              source: "human_confirmation",
              use_count: useCount,
              last_used_at: now,
            },
          })
      );
    } catch (e) {
      console.error("[memory/update] upsert error:", (e as { code?: string })?.code);
      // Do not throw — audit log still attempted below.
    }

    // ── 4. Audit log with redacted values (AC21) ──────────────────────────────
    const redactedPayload = redactObject({
      case_id: caseId,
      field_key: fieldName,
      action: "confirmed",
      old_value: oldValue ?? "",
      new_value: confirmedValue,
    });

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: actorId ?? null,
      event_type: AuditEvent.FIELD_CONFIRMED,
      target_type: "case",
      target_id: caseId,
      payload: redactedPayload,
    });
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    console.error("[memory/update] updateMemoryFromConfirmation exception:", errName);
    // Do not rethrow — memory update failures must not break the primary flow.
  }
}

/**
 * Seed claim_memory from high-confidence extracted fields after a successful
 * first-pass extraction.
 *
 * Seeds sender_profile memory for fields meeting the high-confidence threshold.
 * Applies a confidence discount (× 0.8) because the values are unconfirmed by a human.
 *
 * Only seeds: full_name, dni, policy_number.
 * Never seeds: phone, email (these are lookup keys, not values to seed).
 *
 * AC14: Seeded entries are inserted with low confidence and no confirmed_at.
 *       They are only upgraded to CONFIRMATION_CONFIDENCE after human confirmation.
 *
 * @param tenantId        - UUID of the tenant.
 * @param senderEmail     - Sender's email address (lookup key — PII).
 * @param extractedFields - Array of extracted fields from the AI extractor.
 * @param caseId          - UUID of the case (for audit log).
 */
export async function seedMemoryFromExtraction(
  tenantId: string,
  senderEmail: string,
  extractedFields: ExtractedField[],
  caseId: string
): Promise<void> {
  if (!senderEmail) return;

  try {
    // Filter to only seedable, high-confidence fields.
    const fieldsToSeed = extractedFields.filter(
      (f) =>
        (SEEDABLE_FIELDS as readonly string[]).includes(f.field_key) &&
        f.confidence >= SEED_MIN_CONFIDENCE
    );

    if (fieldsToSeed.length === 0) return;

    const now = new Date().toISOString();

    // Build the sender_profile value object from seedable fields.
    const profileValue: Record<string, unknown> = {};
    for (const f of fieldsToSeed) {
      profileValue[f.field_key] = f.field_value;
    }

    // Compute discounted confidence (lowest field confidence × discount factor).
    const minFieldConfidence = Math.min(...fieldsToSeed.map((f) => f.confidence));
    const seedConfidence = parseFloat(
      (minFieldConfidence * SEED_CONFIDENCE_DISCOUNT).toFixed(2)
    );

    // ── Upsert sender_profile row ─────────────────────────────────────────────
    // Only inserts if no existing row — existing confirmed memory is NOT overwritten.
    // Unique key: idx_claim_memory_tenant_type_key (tenant_id, memory_type, key).
    try {
      const t = tables.claimMemory;
      await enTenant({ tenantId }, (db) =>
        db
          .insert(t)
          .values({
            tenant_id: tenantId,
            memory_type: "sender_profile",
            key: senderEmail,
            value: profileValue,
            confidence: seedConfidence,
            source: "auto_extracted",
            last_used_at: now,
          })
          // ON CONFLICT DO NOTHING: do NOT overwrite an existing confirmed row.
          .onConflictDoNothing({
            target: [t.tenant_id, t.memory_type, t.key],
          })
      );
    } catch (e) {
      console.error(
        "[memory/update] seedMemoryFromExtraction upsert error:",
        (e as { code?: string })?.code
      );
    }

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "memory.seeded_from_extraction",
        case_id: caseId,
        fields_seeded: fieldsToSeed.map((f) => f.field_key),
        seed_confidence: seedConfidence,
        // PII: senderEmail is NOT logged here
      })
    );
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    console.error("[memory/update] seedMemoryFromExtraction exception:", errName);
  }
}
