/**
 * PATCH /api/cases/:id/confirm-field — un analista resuelve un campo extraído.
 *
 * Auth: cualquier rol con sesión, salvo `viewer`, que es de sólo lectura.
 * Límite: CONFIRM_FIELD (30/min por usuario).
 *
 * Cuerpo: { field_key, value, action: 'confirm' | 'correct' | 'reject' }
 * 200: { case_id, field_key, new_status, claim_memory_updated }
 * 404: el caso no existe o es de otra aseguradora. Nunca 403: un 403
 *      confirmaría que existe, y eso solo permite enumerar casos ajenos.
 *
 * Lo que hace vive en `@/server/cases/confirm-field`. Acá quedan las cuatro
 * cosas del borde: quién entra, cuánto puede pedir, qué mandó, y traducir un
 * `AppError` a una respuesta HTTP.
 */

import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, err } from "@/lib/api/respond";
import { ALL_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { entrar } from "@/lib/api/entrada";
import { AppError } from "@/lib/errors";
import {
  RATE_LIMIT_CONFIGS,
  getClientIp,
  type RateLimitResult,
} from "@/lib/rate-limit/index";
import { ConfirmFieldSchema } from "@/lib/schemas/cases";
import { resolveFieldConfirmation } from "@/server/cases/confirm-field";
import { logger } from "@/lib/observability/logger";

const ParamsSchema = z.object({
  id: z.string().uuid("ID de caso inválido."),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  // ── 1. Sesión y rol ───────────────────────────────────────────────────────
  let ctx: RoleContext;
  let rl: RateLimitResult;
  try {
    ({ ctx, rl } = await entrar("confirm-field", RATE_LIMIT_CONFIGS.CONFIRM_FIELD, ...ALL_ROLES));
  } catch {
    return err(new AppError("MISSING_SESSION", "Se requiere autenticación."));
  }
  const { userRow } = ctx;

  // Un viewer mira siniestros; no los toca.
  if (userRow.role === "viewer") {
    return err(new AppError("FORBIDDEN_ROLE", "Tu rol es de solo lectura."));
  }

  const ip = getClientIp(request);

  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes. Esperá un momento."));
  }

  // ── 3. La ruta ────────────────────────────────────────────────────────────
  // Un id mal formado es 404 y no 400: contestar distinto según la forma del id
  // ya es una diferencia observable desde afuera.
  const parsedParams = ParamsSchema.safeParse(await context.params);
  if (!parsedParams.success) {
    return err(new AppError("NOT_FOUND", "El caso no existe."));
  }

  // ── 4. El cuerpo ──────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err(
      new AppError("VALIDATION_FAILED", "El cuerpo de la solicitud no es JSON válido.")
    );
  }

  const parsed = ConfirmFieldSchema.safeParse(body);
  if (!parsed.success) {
    return err(
      new AppError(
        "VALIDATION_FAILED",
        "Los datos enviados no son válidos.",
        parsed.error.flatten().fieldErrors
      )
    );
  }

  // ── 5. Lo que de verdad hace ──────────────────────────────────────────────
  try {
    return ok(
      await resolveFieldConfirmation(
        { tenantId: userRow.tenant_id },
        parsedParams.data.id,
        parsed.data,
        userRow.id,
        // De dónde vino la acción, igual que en el PATCH del caso. Es dato
        // personal de un empleado y va al registro a propósito: un historial
        // donde la mitad de las acciones tiene origen y la otra mitad no, no
        // sirve para lo que existe.
        ip,
        request.headers.get("user-agent")
      )
    );
  } catch (error) {
    if (error instanceof AppError) return err(error);
    logger.error({ detalle: error instanceof Error ? error.name : "UnknownError" }, "patch_api_cases_id_confirm_field.error");
    return err(new AppError("INTERNAL_ERROR"));
  }
}
