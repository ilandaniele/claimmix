/**
 * El borde HTTP del padrón (B16), lo que sus rutas repiten: el alta y la
 * edición a mano de clientes y pólizas, y la importación. Quién entra, cómo se
 * lee el cuerpo y cómo se rechaza con frases en el idioma de la cuenta.
 *
 * Un rechazo lleva `resumen` (las frases) además del `error` de siempre:
 * `FormularioApi` muestra `resumen` línea por línea. `err()` no admite campos
 * de más, por eso el cuerpo se arma acá.
 */

import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";

import { codigosDeRechazo } from "@/core/padron/manual";
import { entrar } from "@/lib/api/entrada";
import { PADRON_EDITOR_ROLES } from "@/lib/auth/roles";
import { AppError, ERROR_STATUS, type ErrorCode } from "@/lib/errors";
import { getT } from "@/lib/i18n";
import { resolveAccountLocale } from "@/lib/i18n/locale";
import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";

import { motivoDe } from "./lineas";

export type Traductor = ReturnType<typeof getT>;

/**
 * Sesión, rol y cupo; devuelve la fila del usuario y el traductor de su cuenta.
 * Sin argumentos es el cupo del alta y la edición a mano; la importación pasa el suyo.
 */
export async function entrarAEscribir(
  etiqueta = "padron-escribir",
  cupo: { limit: number; windowMs: number } = RATE_LIMIT_CONFIGS.PADRON_ESCRIBIR
) {
  const { ctx, rl } = await entrar(etiqueta, cupo, ...PADRON_EDITOR_ROLES);
  if (!rl.allowed) throw new AppError("RATE_LIMITED");
  return { userRow: ctx.userRow, t: getT(await resolveAccountLocale(ctx.userRow.locale)) };
}

/** Un rechazo con una frase por código. */
export function rechazo(t: Traductor, codigos: string[], codigo: ErrorCode = "VALIDATION_FAILED"): NextResponse {
  const resumen = codigos.map((c) => motivoDe(t, c));
  return NextResponse.json({ error: { code: codigo, message: resumen[0] }, resumen }, { status: ERROR_STATUS[codigo] });
}

/** El cuerpo JSON validado con el esquema, o el rechazo que la ruta devuelve tal cual. */
export async function leerCuerpo<S extends z.ZodTypeAny>(
  request: NextRequest,
  esquema: S,
  t: Traductor
): Promise<{ ok: true; datos: z.output<S> } | { ok: false; respuesta: NextResponse }> {
  const analizado = esquema.safeParse(await request.json().catch(() => null));
  if (analizado.success) return { ok: true, datos: analizado.data };
  return { ok: false, respuesta: rechazo(t, codigosDeRechazo(analizado.error)) };
}

/** Los campos que vinieron en el cuerpo, para la auditoría: los nombres, nunca los valores. */
export const camposPresentes = (datos: Record<string, unknown>) =>
  Object.entries(datos)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
