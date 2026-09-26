/**
 * POST /api/cases/:id/reenviar-pedido — reenvía el pedido de datos que falta,
 * y de paso reabre un caso cerrado por abandono.
 *
 * `reenviarPedido` decide todo: si hay algo pendiente, si la ventana de
 * WhatsApp sigue abierta, si el último cierre fue por abandono. Acá sólo se
 * traduce su respuesta a HTTP.
 *
 * 200: { claves, reabierto }. 404: el caso no existe, o la reapertura la pide
 * alguien que no puede cambiarle el estado. 409: RESPUESTA_NO_PERMITIDA con
 * { motivo }. 429: un reenvío por caso cada 30 s.
 */

import { type NextRequest } from "next/server";
import { z } from "zod";
import { CASE_EDITOR_ROLES } from "@/lib/auth/require-role";
import { entrar } from "@/lib/api/entrada";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { RATE_LIMIT_CONFIGS, buildUserKey } from "@/lib/rate-limit/index";
import { reenviarPedido } from "@/server/confirmations/reenvio";

export const maxDuration = 60;

const ParamsSchema = z.object({ id: z.string().uuid() });
const CuerpoSchema = z.object({ reabrir: z.literal(true).optional() });

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const valido = ParamsSchema.safeParse(await context.params);

    const { ctx, rl } = await entrar(
      (u) => buildUserKey(u, `reenviar-pedido:${valido.success ? valido.data.id : "x"}`),
      RATE_LIMIT_CONFIGS.REENVIAR_PEDIDO,
      ...CASE_EDITOR_ROLES
    );
    if (!rl.allowed) return err(new AppError("RATE_LIMITED"));

    // Un id mal formado es 404 y no 400: contestar distinto según la forma del
    // id ya es una diferencia observable desde afuera.
    if (!valido.success) {
      return err(new AppError("NOT_FOUND", "El caso no existe."));
    }

    const cuerpo = CuerpoSchema.safeParse(await request.json().catch(() => ({})));
    if (!cuerpo.success) {
      return err(new AppError("VALIDATION_FAILED", cuerpo.error.issues[0]?.message));
    }

    const resultado = await reenviarPedido(ctx, valido.data.id, cuerpo.data.reabrir === true);

    if (!resultado.ok) {
      if (resultado.motivo === "no_encontrado") {
        return err(new AppError("NOT_FOUND", "El caso no existe."));
      }
      return err(new AppError("RESPUESTA_NO_PERMITIDA", undefined, { motivo: resultado.motivo }));
    }

    return ok({ claves: resultado.claves, reabierto: resultado.reabierto });
  } catch (e) {
    return err(e);
  }
}
