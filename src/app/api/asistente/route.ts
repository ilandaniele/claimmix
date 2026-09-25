/**
 * POST /api/asistente — una pregunta en lenguaje natural sobre los casos del inquilino.
 *
 * Sólo Plan Pro. El modelo elige una de tres herramientas fijas
 * (`IntencionSchema`); todo el resto de la seguridad —tenant, rol, rate limit,
 * enmascarado por rol— vive en `responder.ts` y `herramientas.ts`.
 */

import { z } from "zod";
import { entrar } from "@/lib/api/entrada";
import { ALL_ROLES } from "@/lib/auth/roles";
import type { RoleContext } from "@/lib/auth/require-role";
import { exigirPlanPro } from "@/lib/auth/exigir-plan-pro";
import { RATE_LIMIT_CONFIGS, type RateLimitResult } from "@/lib/rate-limit/index";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { responderPregunta } from "@/server/asistente/responder";

export const maxDuration = 60;

const PreguntaSchema = z
  .object({ pregunta: z.string().trim().min(3).max(500) })
  .strict();

export async function POST(request: Request): Promise<Response> {
  let ctx: RoleContext;
  let rl: RateLimitResult;
  try {
    ({ ctx, rl } = await entrar("asistente", RATE_LIMIT_CONFIGS.ASISTENTE, ...ALL_ROLES));
  } catch (e) {
    return err(e instanceof AppError ? e : new AppError("MISSING_SESSION"));
  }

  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED"), undefined, {
      "Retry-After": String(rl.retryAfterSeconds),
    });
  }

  try {
    exigirPlanPro(ctx);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err(new AppError("VALIDATION_FAILED", "El cuerpo de la solicitud no es JSON válido."));
    }

    const parsed = PreguntaSchema.safeParse(body);
    if (!parsed.success) {
      return err(
        new AppError(
          "VALIDATION_FAILED",
          parsed.error.issues[0]?.message ?? "Datos de entrada inválidos.",
          parsed.error.flatten()
        )
      );
    }

    const respuesta = await responderPregunta(ctx, parsed.data.pregunta);
    return ok(respuesta);
  } catch (e) {
    return err(e instanceof AppError ? e : new AppError("INTERNAL_ERROR"));
  }
}
