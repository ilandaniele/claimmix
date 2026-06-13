/**
 * Email claim gap analyzer — determines which fields are missing, which need
 * confirmation, and the overall completeness status of an email-sourced case.
 *
 * Distinct from the legacy gap-analysis.ts (which serves the simulate flow).
 * This module is specifically designed for the email-intake pipeline and
 * operates against the claim_field_confirmations + missing_docs tables.
 *
 * AC7:  Medium-confidence fields appear in fieldsNeedingConfirmation.
 * AC9:  Conflict rows appear in fieldsNeedingConfirmation with conflictValue.
 * AC10: Missing required fields drive 'info_faltante' status.
 *
 * Required fields for a complete email claim:
 *   full_name, email OR phone, accident_date, accident_description, claim_type
 *
 * This is a pure-function-like module (DB reads only, no DB writes).
 * The orchestrator (confirmations/orchestrate.ts) calls this to decide
 * what status transitions and emails to trigger.
 */

import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimFieldConfirmations, missingDocs } from "@/lib/db/schema";
import type { ExtractedField } from "@/lib/schemas/extracted-claim";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Fields that MUST be present for an email claim to be considered complete.
 * Note: 'email' and 'phone' are treated as a contact pair — at least one required.
 */
export const REQUIRED_CLAIM_FIELDS = [
  "full_name",
  "accident_date",
  "accident_description",
  "claim_type",
] as const;

/** At least one of these contact fields must be present. */
export const REQUIRED_CONTACT_FIELDS = ["email", "phone"] as const;

/** Confidence threshold for 'medium' confidence (IC9). */
const MEDIUM_CONFIDENCE_LOW = 0.60;
const MEDIUM_CONFIDENCE_HIGH = 0.85;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FieldNeedingConfirmation {
  fieldName: string;
  suggestedValue: string;
  conflictValue?: string;
  reason: "low_confidence" | "conflict" | "medium_confidence";
}

export interface GapAnalysisResult {
  /** Required fields not yet extracted at sufficient confidence. */
  missingRequiredFields: string[];
  /** Fields that need analyst confirmation before proceeding. */
  fieldsNeedingConfirmation: FieldNeedingConfirmation[];
  /** Whether all required fields are present and all confirmations resolved. */
  isComplete: boolean;
  /**
   * Overall status determination:
   *   'listo_para_core'       — all required fields + no pending confirmations
   *   'info_faltante'         — one or more required fields missing
   *   'confirmacion_pendiente'— required fields present but pending confirmations
   */
  status: "listo_para_core" | "info_faltante" | "confirmacion_pendiente";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyze the gap status of an email claim.
 *
 * Reads:
 *   - missing_docs table (unresolved gaps from extraction worker)
 *   - claim_field_confirmations table (pending/conflict confirmations)
 *   - extractedFields param (the current extraction result for this run)
 *
 * Does NOT write to the DB — the orchestrator handles all writes.
 *
 * @param caseId         - UUID of the case being analyzed.
 * @param extractedFields - Fields extracted in this run (from ExtractedClaimSchema.fields).
 * @param tenantId       - UUID of the tenant (explicit tenant scoping — RLS is gone).
 */
export async function analyzeEmailClaimGaps(
  caseId: string,
  extractedFields: ExtractedField[],
  tenantId: string
): Promise<GapAnalysisResult> {
  // ── 1. Fetch unresolved missing_docs rows ──────────────────────────────────
  const missingDocKeys = await fetchMissingDocKeys(caseId, tenantId);

  // ── 2. Build a map of extracted field values and confidences ──────────────
  const fieldMap = new Map<string, ExtractedField>();
  for (const f of extractedFields) {
    fieldMap.set(f.field_key, f);
  }

  // ── 3. Determine missing required fields ──────────────────────────────────
  const missingRequiredFields: string[] = [];

  // Check mandatory fields
  for (const reqField of REQUIRED_CLAIM_FIELDS) {
    const extracted = fieldMap.get(reqField);
    const isMissingInDB = missingDocKeys.includes(reqField);

    if (isMissingInDB && !extracted) {
      // Still missing — no re-extraction has provided it
      missingRequiredFields.push(reqField);
    } else if (!extracted && !isMissingInDB) {
      // Not in extracted fields and not in missing_docs — add it
      missingRequiredFields.push(reqField);
    } else if (extracted && extracted.confidence < MEDIUM_CONFIDENCE_LOW) {
      // Below low confidence threshold → treat as missing (AC8, IC9)
      missingRequiredFields.push(reqField);
    }
  }

  // Check contact pair — need at least email OR phone
  const hasEmail = fieldMap.get("email") && (fieldMap.get("email")!.confidence >= MEDIUM_CONFIDENCE_LOW);
  const hasPhone = fieldMap.get("phone") && (fieldMap.get("phone")!.confidence >= MEDIUM_CONFIDENCE_LOW);
  const hasEmailMissing = missingDocKeys.includes("email") && !hasEmail;
  const hasPhoneMissing = missingDocKeys.includes("phone") && !hasPhone;

  if (!hasEmail && !hasPhone && (hasEmailMissing || hasPhoneMissing || (!fieldMap.has("email") && !fieldMap.has("phone")))) {
    // Need at least one contact field
    missingRequiredFields.push("email_or_phone");
  }

  // ── 4. Fetch pending claim_field_confirmations ────────────────────────────
  const pendingConfirmations = await fetchPendingConfirmations(caseId, tenantId);

  // ── 5. Build fieldsNeedingConfirmation from pending rows ──────────────────
  const fieldsNeedingConfirmation: FieldNeedingConfirmation[] = pendingConfirmations.map(
    (row) => ({
      fieldName: row.field_key,
      suggestedValue: row.proposed_value ?? "",
      conflictValue: row.conflict_with_value ?? undefined,
      reason: determineConfirmationReason(row.confidence, !!row.conflict_with_value),
    })
  );

  // ── 6. Also check current extracted fields for medium confidence ──────────
  // (fields not yet in claim_field_confirmations for this run)
  const existingConfirmationKeys = new Set(fieldsNeedingConfirmation.map((f) => f.fieldName));

  for (const f of extractedFields) {
    if (existingConfirmationKeys.has(f.field_key)) continue;
    if (f.confidence >= MEDIUM_CONFIDENCE_LOW && f.confidence < MEDIUM_CONFIDENCE_HIGH) {
      // Medium confidence — needs confirmation (IC9)
      fieldsNeedingConfirmation.push({
        fieldName: f.field_key,
        suggestedValue: f.field_value,
        reason: "medium_confidence",
      });
    }
  }

  // ── 7. Determine overall status ───────────────────────────────────────────
  let status: GapAnalysisResult["status"];

  if (missingRequiredFields.length > 0) {
    // Missing required fields → info_faltante takes priority
    status = "info_faltante";
  } else if (fieldsNeedingConfirmation.length > 0) {
    // All required fields present but pending confirmations
    status = "confirmacion_pendiente";
  } else {
    // All present + confirmed
    status = "listo_para_core";
  }

  const isComplete = status === "listo_para_core";

  return {
    missingRequiredFields,
    fieldsNeedingConfirmation,
    isComplete,
    status,
  };
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** Fetch unresolved (satisfied_at IS NULL) doc keys for this case. */
async function fetchMissingDocKeys(
  caseId: string,
  tenantId: string
): Promise<string[]> {
  try {
    const data = await db
      .select({ doc_key: missingDocs.doc_key })
      .from(missingDocs)
      .where(
        and(
          eq(missingDocs.case_id, caseId),
          eq(missingDocs.tenant_id, tenantId),
          isNull(missingDocs.satisfied_at)
        )
      );

    return data.map((row) => row.doc_key);
  } catch (err) {
    const code =
      (err as { code?: string })?.code ??
      (err instanceof Error ? err.name : "UnknownError");
    console.error("[gap-analyzer] missing_docs fetch error:", code);
    return [];
  }
}

/** Fetch pending (status='pending') claim_field_confirmations for this case. */
async function fetchPendingConfirmations(
  caseId: string,
  tenantId: string
): Promise<Array<{
  field_key: string;
  proposed_value: string | null;
  conflict_with_value: string | null;
  confidence: number;
}>> {
  try {
    // Column names in the Neon schema are field_name / suggested_value —
    // aliased here to preserve the internal field_key / proposed_value shape.
    const data = await db
      .select({
        field_key: claimFieldConfirmations.field_name,
        proposed_value: claimFieldConfirmations.suggested_value,
        conflict_with_value: claimFieldConfirmations.conflict_with_value,
        confidence: claimFieldConfirmations.confidence,
      })
      .from(claimFieldConfirmations)
      .where(
        and(
          eq(claimFieldConfirmations.case_id, caseId),
          eq(claimFieldConfirmations.tenant_id, tenantId),
          eq(claimFieldConfirmations.status, "pending")
        )
      );

    // numeric columns come back as strings from Drizzle — normalize to number.
    return data.map((row) => ({
      ...row,
      confidence: Number(row.confidence),
    }));
  } catch (err) {
    const code =
      (err as { code?: string })?.code ??
      (err instanceof Error ? err.name : "UnknownError");
    console.error("[gap-analyzer] claim_field_confirmations fetch error:", code);
    return [];
  }
}

/**
 * Determine the reason for a confirmation row.
 *
 * If a conflict value exists → 'conflict'.
 * Otherwise, based on confidence:
 *   - below medium band → 'low_confidence'
 *   - within medium band → 'medium_confidence'
 */
function determineConfirmationReason(
  confidence: number,
  hasConflict: boolean
): FieldNeedingConfirmation["reason"] {
  if (hasConflict) return "conflict";
  if (confidence < MEDIUM_CONFIDENCE_LOW) return "low_confidence";
  return "medium_confidence";
}
