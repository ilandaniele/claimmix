/**
 * POST /api/cases/:id/export-to-core — returns structured JSON payload
 * that would be sent to the insurer's core system.
 *
 * Out of scope per spec: no actual HTTP push in MVP.
 * Returns the payload as-is for integration development.
 *
 * Auth: required.
 * IDOR: case must belong to authenticated user's tenant.
 */

import { and, eq } from "drizzle-orm";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { cases, extractedFields, missingDocs } from "@/lib/db/schema";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";

const ParamsSchema = z.object({
  id: z.string().uuid("ID de caso inválido."),
});

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const rawParams = await context.params;
  const paramsParsed = ParamsSchema.safeParse(rawParams);
  if (!paramsParsed.success) {
    return err(new AppError("VALIDATION_FAILED", paramsParsed.error.issues[0]?.message));
  }
  const caseId = paramsParsed.data.id;

  // ── Auth ──────────────────────────────────────────────────────────────────────
  let ctx: Awaited<ReturnType<typeof requireRole>>;
  try {
    ctx = await requireRole("owner", "admin", "specialist", "analyst");
  } catch (e) {
    if (e instanceof AppError) return err(e);
    throw e;
  }
  const { userRow } = ctx;
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  // Este contexto es lo único que le dice de quién son los datos.
  const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };

  // ── Case detail (explicit tenant filter = IDOR protection) ───────────────────
  const [caseRow] = await enTenant(tenantCtx, (db) =>
    db
      .select()
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1)
  );

  if (!caseRow) return err(new AppError("NOT_FOUND"));

  // ── Extracted fields ─────────────────────────────────────────────────────────
  const fields = await enTenant(tenantCtx, (db) =>
    db
      .select({ field_key: extractedFields.field_key, field_value: extractedFields.field_value, confidence: extractedFields.confidence })
      .from(extractedFields)
      .where(eq(extractedFields.case_id, caseId))
  );

  // ── Missing docs ─────────────────────────────────────────────────────────────
  const docs = await enTenant(tenantCtx, (db) =>
    db
      .select({
        doc_key: missingDocs.doc_key,
        requested_at: missingDocs.requested_at,
        satisfied_at: missingDocs.satisfied_at,
        // Carried through separately: the core system must not read "the
        // claimant says no such report exists" as "we have the report".
        declined_at: missingDocs.declined_at,
        declined_note: missingDocs.declined_note,
      })
      .from(missingDocs)
      .where(eq(missingDocs.case_id, caseId))
  );

  // ── Build core-system payload ─────────────────────────────────────────────────
  const payload = {
    _note: "Payload de integración. En producción este objeto se enviaría al sistema core del asegurador vía HTTP POST.",
    case_id: caseRow.id,
    policy_number: caseRow.policy_number,
    policyholder_name: caseRow.policyholder_name,
    claim_type: caseRow.claim_type,
    status: caseRow.status,
    confidence_min: caseRow.confidence_min,
    channel: caseRow.channel,
    created_at: caseRow.created_at,
    updated_at: caseRow.updated_at,
    closed_at: caseRow.closed_at,
    extracted_fields: fields,
    missing_docs: docs,
    exported_at: new Date().toISOString(),
    exported_by: userRow.id,
  };

  return ok(payload);
}
