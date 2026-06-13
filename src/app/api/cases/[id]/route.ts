/**
 * GET  /api/cases/:id — case detail with extracted_fields, missing_docs, audit_log.
 * PATCH /api/cases/:id — update case status / assigned_to with FSM validation.
 *
 * AC10: Wrong-tenant case returns 404 NOT_FOUND (never 403) — IDOR prevention.
 * AC14: Detail returns extracted_fields[], missing_docs[], audit_log[] (last 20, desc).
 * AC15: PATCH writes audit_log entry; wrong-tenant PATCH returns 404.
 *
 * RLS is gone — every query filters explicitly by the caller's tenant_id.
 */

import { type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { requireRole, ALL_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { cases } from "@/lib/db/schema";
import { CasePatchSchema } from "@/lib/schemas/cases";
import { getCaseDetail } from "@/server/cases/get";
import { patchCase } from "@/server/cases/patch";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
  getClientIp,
} from "@/lib/rate-limit/index";
import type { CaseRow } from "@/lib/db/types";
import { z } from "zod";

// ── Shared: resolve authenticated user + their public.users row ───────────────

async function resolveContext(): Promise<RoleContext | null> {
  try {
    return await requireRole(...ALL_ROLES);
  } catch {
    return null;
  }
}

/** Drizzle numeric → string; convert confidence_min back to number for the JSON shape. */
function serializeCase(row: CaseRow) {
  return {
    ...row,
    confidence_min:
      row.confidence_min === null ? null : Number(row.confidence_min),
  };
}

// ── Route params schema ───────────────────────────────────────────────────────

const ParamsSchema = z.object({
  id: z.string().uuid("ID de caso inválido."),
});

// ── GET /api/cases/:id ────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  // ── 1. Auth ───────────────────────────────────────────────────────────────
  const ctx = await resolveContext();
  if (!ctx) {
    return err(new AppError("MISSING_SESSION", "Se requiere autenticación."));
  }
  const { userRow } = ctx;

  // ── 2. Rate limit ─────────────────────────────────────────────────────────
  const rlKey = buildUserKey(userRow.id, "cases-get");
  const rl = await rateLimit(rlKey, RATE_LIMIT_CONFIGS.CASES_API);
  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes."));
  }

  // ── 3. Validate route params — Next.js 16: params is a Promise ───────────
  const rawParams = await context.params;
  const parsedParams = ParamsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    return err(new AppError("NOT_FOUND", "El caso no existe."));
  }

  const { id: caseId } = parsedParams.data;

  // ── 4. Fetch case detail (explicit tenant_id filter) ─────────────────────
  try {
    const detail = await getCaseDetail(userRow.tenant_id, caseId);
    if (!detail) {
      // Case not found OR belongs to different tenant — always 404, never 403.
      return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
    }
    // numeric columns come back as strings from Drizzle — convert so the JSON
    // shape matches the previous PostgREST response (numbers).
    return ok({
      ...detail,
      case: serializeCase(detail.case),
      extracted_fields: detail.extracted_fields.map((f) => ({
        ...f,
        confidence: Number(f.confidence),
      })),
    });
  } catch (error) {
    const errName = error instanceof Error ? error.name : "UnknownError";
    console.error("[GET /api/cases/:id] error:", errName);
    return err(new AppError("INTERNAL_ERROR"));
  }
}

// ── DELETE /api/cases/:id ─────────────────────────────────────────────────────

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  // ── 1. Auth ───────────────────────────────────────────────────────────────
  const ctx = await resolveContext();
  if (!ctx) {
    return err(new AppError("MISSING_SESSION", "Se requiere autenticación."));
  }
  const { userRow } = ctx;

  // Viewers are read-only.
  if (userRow.role === "viewer") {
    return err(new AppError("FORBIDDEN_ROLE", "Tu rol es de solo lectura."));
  }

  // ── 2. Rate limit ─────────────────────────────────────────────────────────
  const rlKey = buildUserKey(userRow.id, "cases-delete");
  const rl = await rateLimit(rlKey, RATE_LIMIT_CONFIGS.CASES_API);
  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes."));
  }

  // ── 3. Validate route params ──────────────────────────────────────────────
  const rawParams = await context.params;
  const parsedParams = ParamsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    return err(new AppError("NOT_FOUND", "El caso no existe."));
  }

  const { id: caseId } = parsedParams.data;

  // ── 4. Verify case exists and belongs to tenant (IDOR) ────────────────────
  let existing: { id: string } | null;
  try {
    existing = firstRow(
      await db
        .select({ id: cases.id })
        .from(cases)
        .where(and(eq(cases.id, caseId), eq(cases.tenant_id, userRow.tenant_id)))
        .limit(1)
    );
  } catch {
    existing = null;
  }

  if (!existing) {
    return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
  }

  // ── 5. Hard delete (explicit tenant_id filter ensures isolation) ──────────
  try {
    await db
      .delete(cases)
      .where(and(eq(cases.id, caseId), eq(cases.tenant_id, userRow.tenant_id)));

    return ok({ deleted: true });
  } catch (error) {
    const errName = error instanceof Error ? error.name : "UnknownError";
    console.error("[DELETE /api/cases/:id] error:", errName);
    return err(new AppError("INTERNAL_ERROR"));
  }
}

// ── PATCH /api/cases/:id ──────────────────────────────────────────────────────

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  // ── 1. Auth ───────────────────────────────────────────────────────────────
  const ctx = await resolveContext();
  if (!ctx) {
    return err(new AppError("MISSING_SESSION", "Se requiere autenticación."));
  }
  const { userRow } = ctx;

  // Viewers are read-only.
  if (userRow.role === "viewer") {
    return err(new AppError("FORBIDDEN_ROLE", "Tu rol es de solo lectura."));
  }

  // ── 2. Rate limit ─────────────────────────────────────────────────────────
  const ip = getClientIp(request);
  const rlKey = buildUserKey(userRow.id, "cases-patch");
  const rl = await rateLimit(rlKey, RATE_LIMIT_CONFIGS.CASES_API);
  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes."));
  }

  // ── 3. Validate route params ──────────────────────────────────────────────
  const rawParams = await context.params;
  const parsedParams = ParamsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    return err(new AppError("NOT_FOUND", "El caso no existe."));
  }

  const { id: caseId } = parsedParams.data;

  // ── 4. Parse and validate request body ───────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err(
      new AppError(
        "VALIDATION_FAILED",
        "El cuerpo de la solicitud no es JSON válido."
      )
    );
  }

  const parsed = CasePatchSchema.safeParse(body);
  if (!parsed.success) {
    return err(
      new AppError(
        "VALIDATION_FAILED",
        "Los datos enviados no son válidos.",
        parsed.error.flatten().fieldErrors
      )
    );
  }

  // ── 5. Apply patch (FSM validation + ownership + audit log) ──────────────
  try {
    const ua = request.headers.get("user-agent");
    const result = await patchCase(caseId, parsed.data, userRow, ip, ua);
    return ok({ case: serializeCase(result.case) });
  } catch (error) {
    if (error instanceof AppError) {
      return err(error);
    }
    const errName = error instanceof Error ? error.name : "UnknownError";
    console.error("[PATCH /api/cases/:id] error:", errName);
    return err(new AppError("INTERNAL_ERROR"));
  }
}
