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
    /*
     * El error del proveedor va al log, no a quien llamó.
     *
     * Devolvía `e.message` tal cual. Un mensaje de Gemini trae el modelo, la
     * versión de la API, a veces el proyecto de GCP y el motivo exacto del
     * rechazo —cuota, clave inválida, región—. Ahí afuera eso es un mapa de la
     * infraestructura, y esta ruta la alcanza cualquiera con una sesión de
     * demo.
     *
     * Quien llama no puede hacer nada con esa diferencia: en todos los casos lo
     * que corresponde es reintentar o avisar. El detalle queda del lado de
     * adentro, que es donde alguien puede actuar sobre él.
     */
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "demo.analyze.extractor_error",
        error_name: e instanceof Error ? e.name : "UnknownError",
        // El mensaje entero al log —acá adentro sí sirve— y recortado, que los
        // de los proveedores a veces traen la petición completa.
        detail: e instanceof Error ? e.message.slice(0, 300) : undefined,
      })
    );
    return err(new AppError("INTERNAL_ERROR"));
  }

  return ok(result);
}
