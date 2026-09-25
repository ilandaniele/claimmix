/**
 * GET /api/cases/:id/messages — la conversación completa del caso, entrante y
 * saliente, por mail o por WhatsApp.
 *
 * AC8: Returns 200 + messages array (id, direction, provider, subject,
 *      from_addr, body_text, received_at, estado_envio, attachment_count),
 *      oldest first: the last 50, with `recortada` true when there were more.
 * AC9: Returns 404 NOT_FOUND when case belongs to a different tenant (IDOR safe).
 * AC10: Returns 200 + { messages: [], recortada: false } when the case has no messages.
 * AC13: body_text is truncated to 2000 chars server-side, after masking.
 * AC14: attachment_count aggregated from claim_attachments per message.
 * P8: also returns `respuesta` (EstadoDeRespuesta) — whether this user can
 *     reply by WhatsApp from this case right now, and why not if not.
 *
 * Security:
 * - Auth: Better Auth session; tenant isolation by RLS through `enTenantVarias`.
 * - IDOR: case lookup travels in the same batch (404 not 403 for wrong-tenant).
 * - PII: from_addr, subject, body_text are PII — NEVER logged; masked for viewer.
 * - Rate limit: CASES_API (100/min per user).
 */

import { type NextRequest } from "next/server";
import { ALL_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { mensajesSinPiiSiNoCorresponde } from "@/server/cases/pii";
import { conversacionDelCaso } from "@/server/cases/conversacion";
import { estadoDeRespuesta } from "@/core/whatsapp/puede-responder";
import { entrar } from "@/lib/api/entrada";
import { type TenantContext } from "@/data/scope";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  RATE_LIMIT_CONFIGS,
  type RateLimitResult,
} from "@/lib/rate-limit/index";
import { z } from "zod";
import { logger } from "@/lib/observability/logger";

// ── Params schema ─────────────────────────────────────────────────────────────

const ParamsSchema = z.object({
  id: z.string().uuid("ID de caso inválido."),
});

// ── Constants ─────────────────────────────────────────────────────────────────

const BODY_TEXT_MAX_CHARS = 2000;

/** Extract a loggable error code from a thrown DB error (PII-safe). */
function dbErrCode(e: unknown): string {
  return (
    (e as { code?: string })?.code ??
    (e instanceof Error ? e.name : "UnknownError")
  );
}

// ── GET /api/cases/:id/messages ───────────────────────────────────────────────

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  // ── 1. Auth ───────────────────────────────────────────────────────────────
  let ctx: RoleContext;
  let rl: RateLimitResult;
  try {
    ({ ctx, rl } = await entrar("cases-messages-get", RATE_LIMIT_CONFIGS.CASES_API, ...ALL_ROLES));
  } catch {
    return err(new AppError("MISSING_SESSION", "Se requiere autenticación."));
  }
  const { userRow } = ctx;
  const tenantId = userRow.tenant_id;
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    // Este contexto es lo único que le dice de quién son los datos.
    const tenantCtx: TenantContext = { tenantId: tenantId };

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

  // ── 4. La conversación, en un solo viaje ─────────────────────────────────
  try {
    const conversacion = await conversacionDelCaso(tenantCtx, caseId);
    if (!conversacion) {
      // Caso inexistente o de otro inquilino: siempre 404, nunca 403.
      return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
    }

    /*
     * Lo que escribió la persona no sale crudo para quien sólo mira, y lo que
     * le contestó el agente tampoco: repite su DNI y su póliza. El corte y su
     * porqué están en `@/server/cases/pii`.
     *
     * Primero se enmascara y después se recorta: cortar antes puede partir un
     * DNI al medio y dejar pedazos que la redacción ya no reconoce.
     */
    const messages = mensajesSinPiiSiNoCorresponde(conversacion.messages, userRow.role).map((m) => ({
      ...m,
      body_text: m.body_text?.slice(0, BODY_TEXT_MAX_CHARS) ?? null,
    }));

    const respuesta = estadoDeRespuesta({
      plan: userRow.plan,
      role: userRow.role,
      channel: conversacion.channel,
      status: conversacion.status,
      ultimoEntrante: conversacion.ultimoEntranteWhatsApp,
      ahora: new Date(),
    });

    return ok({ messages, recortada: conversacion.recortada, respuesta });
  } catch (e) {
    logger.error({ code: dbErrCode(e) }, "get_api_cases_id_messages.messages_query_error");
    return err(new AppError("INTERNAL_ERROR"));
  }
}
