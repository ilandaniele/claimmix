/**
 * GET  /api/cases/:id — case detail with extracted_fields, missing_docs, audit_log.
 * PATCH /api/cases/:id — update case status / assigned_to with FSM validation.
 *
 * AC10: Wrong-tenant case returns 404 NOT_FOUND (never 403) — IDOR prevention.
 * AC14: Detail returns extracted_fields[], missing_docs[], audit_log[] (last 20, desc).
 * AC15: PATCH writes audit_log entry; wrong-tenant PATCH returns 404.
 */

import { type NextRequest } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
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
import type { Database } from "@/lib/supabase/types";
import { z } from "zod";

type UserRow = Database["public"]["Tables"]["users"]["Row"];

// ── Shared: resolve authenticated user + their public.users row ───────────────

async function resolveUser(supabase: Awaited<ReturnType<typeof createServerClient>>) {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

   
  const { data: userRowRaw } = await (supabase as any)
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single();

  return userRowRaw as UserRow | null;
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
  const supabase = await createServerClient();
  const userRow = await resolveUser(supabase);

  if (!userRow) {
    return err(new AppError("MISSING_SESSION", "Se requiere autenticación."));
  }

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

  // ── 4. Fetch case detail (RLS-scoped) ────────────────────────────────────
  try {
    const detail = await getCaseDetail(supabase, caseId);
    if (!detail) {
      // Case not found OR belongs to different tenant — always 404, never 403.
      return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
    }
    return ok(detail);
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
  const supabase = await createServerClient();
  const userRow = await resolveUser(supabase);

  if (!userRow) {
    return err(new AppError("MISSING_SESSION", "Se requiere autenticación."));
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
  const { data: existing } = await (supabase as any)
    .from("cases")
    .select("id, tenant_id")
    .eq("id", caseId)
    .single();

  if (!existing || existing.tenant_id !== userRow.tenant_id) {
    return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
  }

  // ── 5. Hard delete (RLS ensures tenant isolation) ─────────────────────────
  try {
    const { error: deleteError } = await (supabase as any)
      .from("cases")
      .delete()
      .eq("id", caseId);

    if (deleteError) {
      console.error("[DELETE /api/cases/:id] db error:", deleteError.message);
      return err(new AppError("INTERNAL_ERROR"));
    }

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
  const supabase = await createServerClient();
  const userRow = await resolveUser(supabase);

  if (!userRow) {
    return err(new AppError("MISSING_SESSION", "Se requiere autenticación."));
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
    const result = await patchCase(supabase, caseId, parsed.data, userRow, ip, ua);
    return ok(result);
  } catch (error) {
    if (error instanceof AppError) {
      return err(error);
    }
    const errName = error instanceof Error ? error.name : "UnknownError";
    console.error("[PATCH /api/cases/:id] error:", errName);
    return err(new AppError("INTERNAL_ERROR"));
  }
}
