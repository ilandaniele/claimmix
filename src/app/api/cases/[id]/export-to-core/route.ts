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

import { type NextRequest } from "next/server";
import { z } from "zod";
import { createServerClient } from "@/lib/supabase/server";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import type { Database } from "@/lib/supabase/types";

type UserRow = Database["public"]["Tables"]["users"]["Row"];

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

  // ── Auth ─────────────────────────────────────────────────────────────────────
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return err(new AppError("MISSING_SESSION"));

   
  const { data: userRowRaw } = await (supabase as any)
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single();

  const userRow = userRowRaw as UserRow | null;
  if (!userRow) return err(new AppError("MISSING_SESSION"));

  // ── Case detail with RLS scoping ─────────────────────────────────────────────
   
  const { data: caseRow } = await (supabase as any)
    .from("cases")
    .select("*")
    .eq("id", caseId)
    .single();

  if (!caseRow) return err(new AppError("NOT_FOUND"));

  // ── Extracted fields ──────────────────────────────────────────────────────────
   
  const { data: fields } = await (supabase as any)
    .from("extracted_fields")
    .select("field_key,field_value,confidence")
    .eq("case_id", caseId);

  // ── Missing docs ──────────────────────────────────────────────────────────────
   
  const { data: missingDocs } = await (supabase as any)
    .from("missing_docs")
    .select("doc_key,requested_at,satisfied_at")
    .eq("case_id", caseId);

  // ── Build core-system payload ─────────────────────────────────────────────────
  const payload = {
    _note:
      "Payload de integración. En producción este objeto se enviaría al sistema core del asegurador vía HTTP POST.",
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
    extracted_fields: fields ?? [],
    missing_docs: missingDocs ?? [],
    exported_at: new Date().toISOString(),
    exported_by: userRow.id,
  };

  return ok(payload);
}
