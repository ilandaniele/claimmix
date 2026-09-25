/**
 * POST /api/cases/:id/respondido — «Marcar como respondido».
 *
 * Saca el caso de «Para responder»: una persona ya contestó lo que llegó
 * después de que el agente terminó. El cuerpo lleva `visto`, cuándo cargó el
 * caso quien contesta: lo que entró después no lo vio.
 *
 * `{ actualizado: false }` cuando no había nada que sacar: el caso no estaba
 * marcado, entró algo después de `visto`, no existe o es de otro inquilino — la
 * base no distingue, y decirlo sería contarle a alguien que existe un caso ajeno.
 */

import { type NextRequest } from "next/server";
import { z } from "zod";
import { CASE_EDITOR_ROLES } from "@/lib/auth/require-role";
import { entrar } from "@/lib/api/entrada";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { AuditEvent, writeAuditLog } from "@/lib/audit/log";
import { getClientIp, RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { marcarRespondido } from "@/server/cases/para-responder";

const ParamsSchema = z.object({ id: z.string().uuid("ID de caso inválido.") });
const BodySchema = z.object({ visto: z.string().datetime({ offset: true }) });

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { ctx, rl } = await entrar(
      "cases-respondido",
      RATE_LIMIT_CONFIGS.CASES_API,
      ...CASE_EDITOR_ROLES
    );
    if (!rl.allowed) return err(new AppError("RATE_LIMITED"));

    const parsed = ParamsSchema.safeParse(await context.params);
    if (!parsed.success) {
      return err(new AppError("VALIDATION_FAILED", parsed.error.issues[0]?.message));
    }
    const cuerpo = BodySchema.safeParse(await request.json().catch(() => null));
    if (!cuerpo.success) {
      return err(new AppError("VALIDATION_FAILED", cuerpo.error.issues[0]?.message));
    }
    const caseId = parsed.data.id;
    const { userRow } = ctx;

    const actualizado = await marcarRespondido(
      { tenantId: userRow.tenant_id },
      caseId,
      cuerpo.data.visto
    );
    if (actualizado) {
      await writeAuditLog({
        tenant_id: userRow.tenant_id,
        actor_id: userRow.id,
        event_type: AuditEvent.CASE_MARKED_ANSWERED,
        target_type: "case",
        target_id: caseId,
        ip: getClientIp(request),
        ua: request.headers.get("user-agent") ?? undefined,
      });
    }

    return ok({ actualizado });
  } catch (e) {
    return err(e);
  }
}
