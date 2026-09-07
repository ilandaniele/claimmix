/**
 * POST /api/demo/analyze — run Gemini extraction on pasted email text without
 * creating a case. Designed for live demos to aseguradoras.
 *
 * Auth: required (any authenticated user).
 * Rate limit: 10/min per user (reuses INTAKE_SIMULATE config).
 * Presupuesto: pasa por `checkBudget`, como toda ruta que llama al modelo.
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
  getClientIp,
} from "@/lib/rate-limit/index";
import { checkBudget } from "@/server/ai/budget";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

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

  /*
   * ── 4. Tope de gasto ───────────────────────────────────────────────────────
   *
   * Esta ruta llamaba al modelo sin preguntarle nada al presupuesto. Era la
   * única de las cuatro que gastan: simular, reanalizar y el lote en tanda
   * pasan todas por acá. El límite de tasa acota la RÁFAGA —diez por minuto por
   * persona— pero no el TOTAL: con una sesión, diez llamadas por minuto durante
   * una tarde se comen el presupuesto de la aseguradora, y el tope diario que
   * existe para impedirlo no se enteraba.
   *
   * Importa por dónde entra: `checkBudget` es el único límite que, al llegar,
   * frena las denuncias de verdad. Una demo que lo vacía deja sin atender a los
   * asegurados de esa aseguradora.
   */
  const ip = getClientIp(request);
  const budgetResult = await checkBudget(userRow.tenant_id, userRow.id);
  if (budgetResult.exceeded) {
    await writeAuditLog({
      tenant_id: userRow.tenant_id,
      actor_id: userRow.id,
      event_type: AuditEvent.AI_BUDGET_EXCEEDED,
      target_type: null,
      target_id: null,
      payload: { reason: budgetResult.reason, ruta: "demo-analyze" },
      ip,
      ua: request.headers.get("user-agent") ?? undefined,
    });
    return err(
      new AppError("AI_BUDGET_EXCEEDED", budgetResult.reason, {
        reason: budgetResult.reason,
      })
    );
  }

  // ── 5. Run extraction (no DB writes) ─────────────────────────────────────────
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
