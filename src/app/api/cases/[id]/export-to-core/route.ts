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

import { CASE_EDITOR_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { enTenantVarias, type TenantContext } from "@/data/scope";
import { entrar } from "@/lib/api/entrada";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { RATE_LIMIT_CONFIGS, type RateLimitResult } from "@/lib/rate-limit/index";
import { consultasDelCaso, type DelCaso } from "@/server/core-sync/lectura";

const ParamsSchema = z.object({
  id: z.guid("ID de caso inválido."),
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
  let ctx: RoleContext;
  let rl: RateLimitResult;
  try {
    ({ ctx, rl } = await entrar("export-to-core", RATE_LIMIT_CONFIGS.CASES_API, ...CASE_EDITOR_ROLES));
  } catch (e) {
    if (e instanceof AppError) return err(e);
    throw e;
  }
  if (!rl.allowed) return err(new AppError("RATE_LIMITED"));
  const { userRow } = ctx;
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  // Este contexto es lo único que le dice de quién son los datos.
  const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };

  // Caso, campos y documentos en un solo viaje; la forma es la de /api/v1.
  const [[caso], fields, docs] = await enTenantVarias<DelCaso>(tenantCtx, (db) => consultasDelCaso(db, caseId));
  if (!caso) return err(new AppError("NOT_FOUND"));

  // ── Build core-system payload ─────────────────────────────────────────────────
  const payload = {
    _note: "Payload de integración. En producción este objeto se enviaría al sistema core del asegurador vía HTTP POST.",
    ...caso,
    extracted_fields: fields,
    missing_docs: docs,
    exported_at: new Date().toISOString(),
    exported_by: userRow.id,
  };

  return ok(payload);
}
