/**
 * POST /api/demo/analyze — run Gemini extraction on pasted email text without
 * creating a case. Designed for live demos to aseguradoras.
 *
 * Auth: required (any authenticated user).
 * Rate limit: 10/min per user (reuses INTAKE_SIMULATE config).
 * No DB writes — extraction result is returned directly.
 */

import "server-only";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole, ALL_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { extractEmailClaimGemini } from "@/server/ai/gemini-extractor";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
} from "@/lib/rate-limit/index";

export const maxDuration = 60;

const DemoAnalyzeSchema = z.object({
  subject: z.string().min(1).max(500),
  body: z.string().min(10).max(20_000),
});

export async function POST(request: NextRequest): Promise<Response> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────────
  let ctx: RoleContext;
  try {
    ctx = await requireRole(...ALL_ROLES);
  } catch (e) {
    return err(e instanceof AppError ? e : new AppError("INTERNAL_ERROR"));
  }
  const { user, userRow } = ctx;

  // ── 2. Rate limit ─────────────────────────────────────────────────────────────
  const rlKey = buildUserKey(user.id, "demo-analyze");
  const rlResult = await rateLimit(rlKey, RATE_LIMIT_CONFIGS.INTAKE_SIMULATE);
  if (!rlResult.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          code: "RATE_LIMITED",
          message: "Demasiadas solicitudes. Esperá un momento.",
        },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(rlResult.retryAfterSeconds),
        },
      }
    );
  }

  // ── 3. Validate body ──────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err(new AppError("VALIDATION_FAILED", "El cuerpo no es JSON válido."));
  }

  const parsed = DemoAnalyzeSchema.safeParse(body);
  if (!parsed.success) {
    return err(
      new AppError(
        "VALIDATION_FAILED",
        parsed.error.issues[0]?.message ?? "Datos de entrada inválidos.",
        parsed.error.flatten()
      )
    );
  }

  // ── 4. Run extraction (no DB writes) ─────────────────────────────────────────
  let result;
  try {
    result = await extractEmailClaimGemini(
      {
        subject: parsed.data.subject,
        body: parsed.data.body,
        memoryHints: [],
        knownPatterns: [],
      },
      userRow.tenant_id,
      "demo",
      user.id
    );
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Error al contactar Gemini.";
    return err(new AppError("INTERNAL_ERROR", message));
  }

  return ok(result);
}
