/**
 * POST /api/cases/:id/responder — una persona responde por WhatsApp desde el caso.
 *
 * Sólo Plan Pro, sólo con el agente ya terminado, sólo dentro de la ventana de
 * 24 h de Meta — `responderPorWhatsApp` vuelve a exigir del lado del servidor
 * lo que el GET de mensajes ya mostró. El destinatario sale de
 * `cases.email_thread_id`, nunca del cuerpo del pedido.
 *
 * 200: { id, estado }. 404: el caso no existe o es de otro inquilino.
 * 409: RESPUESTA_NO_PERMITIDA con { motivo }. 502: el envío a Meta falló (la
 * fila de outbound queda con status failed).
 */

import { type NextRequest } from "next/server";
import { z } from "zod";
import { CASE_EDITOR_ROLES } from "@/lib/auth/require-role";
import { entrar } from "@/lib/api/entrada";
import { exigirPlanPro } from "@/lib/auth/exigir-plan-pro";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { RespuestaHumanaSchema } from "@/lib/schemas/respuesta";
import { responderPorWhatsApp } from "@/server/confirmations/respuesta-humana";

const ParamsSchema = z.object({ id: z.string().uuid("ID de caso inválido.") });

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { ctx, rl } = await entrar(
      "cases-responder",
      RATE_LIMIT_CONFIGS.RESPUESTA_HUMANA,
      ...CASE_EDITOR_ROLES
    );
    if (!rl.allowed) return err(new AppError("RATE_LIMITED"));

    exigirPlanPro(ctx);

    // Un id mal formado es 404 y no 400: contestar distinto según la forma del
    // id ya es una diferencia observable desde afuera.
    const parsedParams = ParamsSchema.safeParse(await context.params);
    if (!parsedParams.success) {
      return err(new AppError("NOT_FOUND", "El caso no existe."));
    }

    const cuerpo = RespuestaHumanaSchema.safeParse(await request.json().catch(() => null));
    if (!cuerpo.success) {
      return err(new AppError("VALIDATION_FAILED", cuerpo.error.issues[0]?.message));
    }

    const resultado = await responderPorWhatsApp(ctx, parsedParams.data.id, cuerpo.data.texto);

    if (!resultado.ok) {
      if (resultado.motivo === "no_encontrado") {
        return err(new AppError("NOT_FOUND", "El caso no existe."));
      }
      if (resultado.motivo === "envio_fallido") {
        return err(new AppError("ENVIO_FALLIDO"));
      }
      return err(new AppError("RESPUESTA_NO_PERMITIDA", undefined, { motivo: resultado.motivo }));
    }

    return ok({ id: resultado.id, estado: resultado.estado });
  } catch (e) {
    return err(e);
  }
}
