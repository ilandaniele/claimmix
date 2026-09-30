/**
 * PATCH /api/cases/:id/plan — tildar o destildar un paso del plan de trabajo (B11).
 *
 * Cuerpo: { clave, hecho }. Sólo el equipo que edita casos; un analista, sólo en
 * un caso libre o suyo. Un paso que no existe, un caso ajeno y uno de otro
 * inquilino contestan lo mismo, 404: decir cuál de los tres sería contarle a
 * alguien que existe algo que no puede ver.
 */

import { type NextRequest } from "next/server";
import { z } from "zod";
import { CASE_EDITOR_ROLES } from "@/lib/auth/require-role";
import { entrar } from "@/lib/api/entrada";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { marcarPaso } from "@/server/cases/plan-de-trabajo";

const ParamsSchema = z.object({ id: z.string().uuid("ID de caso inválido.") });
const BodySchema = z
  .object({ clave: z.string().min(1).max(80), hecho: z.boolean() })
  .strict();

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { ctx, rl } = await entrar(
      "cases-plan",
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

    const { userRow } = ctx;
    const cambio = await marcarPaso(
      { tenantId: userRow.tenant_id },
      parsed.data.id,
      cuerpo.data.clave,
      cuerpo.data.hecho,
      { id: userRow.id, role: userRow.role }
    );
    if (!cambio) return err(new AppError("NOT_FOUND"));

    return ok({ clave: cuerpo.data.clave, hecho: cuerpo.data.hecho });
  } catch (e) {
    return err(e);
  }
}
