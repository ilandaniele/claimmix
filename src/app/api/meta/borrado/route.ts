/**
 * POST /api/meta/borrado — el aviso de borrado de datos que pide Meta (Data Deletion
 * Request URL de la app).
 *
 * Meta lo llama cuando una persona saca la app de su cuenta y pide que se borren sus
 * datos. Manda `signed_request` (form urlencoded): el HMAC-SHA256 con el secreto de la
 * app, un punto y el payload con el `user_id` de Facebook de quien lo pidió. Sin firma
 * válida no se toca nada.
 *
 * Lo que se borra es lo que Meta nos dio de esa persona: el token y el PIN de la WABA
 * que conectó (`bajaDeWaba`, la misma baja que usan el operador y el aviso de revocación).
 * Los casos y mensajes de los asegurados son del cliente y no se tocan acá.
 *
 * Meta espera `{ url, confirmation_code }`: una página donde la persona ve el estado
 * del pedido y un código para reclamar. Si el usuario no conectó ninguna WABA acá
 * igual se contesta con un código, porque no hay nada que borrar y eso es el resultado
 * correcto. El `user_id` del pedido es el de la persona que conectó (el que informa el
 * popup al vincular); si no coincide con ninguno queda `meta_borrado.sin_coincidencia`
 * en el registro para que el dueño lo borre a mano desde /admin/altas.
 *
 * /api queda fuera del proxy, así que no hay sesión: el tope por IP es lo único que frena
 * a quien no sea Meta.
 */

import "server-only";
import { randomBytes } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { resolveBaseURL } from "@/lib/auth/base-url";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { getClientIp, rateLimit } from "@/lib/rate-limit/index";
import { bajaDeWaba } from "@/server/alta/panel-operador";
import { leerPedidoFirmado } from "@/server/whatsapp/embedded-signup";

/** Un `signed_request` real mide unos cientos de bytes; esto es para no leer cuerpos enormes. */
const CUERPO_MAXIMO = 8_192;
/** Meta llama desde pocas IPs y pide una vez por persona: esto sobra para ellos y frena un loop. */
const TOPE = { limit: 30, windowMs: 60_000 };

const falla = (status: number, code: string, message: string, headers?: Record<string, string>) =>
  NextResponse.json({ error: { code, message } }, { status, headers });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rl = await rateLimit(claveDeCupo("meta:borrado", getClientIp(request)), TOPE);
  if (!rl.allowed) {
    return falla(429, "RATE_LIMITED", "Too many requests.", { "Retry-After": String(rl.retryAfterSeconds) });
  }

  const cuerpo = await request.text();
  if (cuerpo.length > CUERPO_MAXIMO) return falla(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");

  const pedido = leerPedidoFirmado(new URLSearchParams(cuerpo).get("signed_request") ?? "");
  if (!pedido) {
    logger.warn({}, "meta_borrado.pedido_invalido");
    return falla(400, "INVALID_SIGNED_REQUEST", "The signed_request is missing or not valid.");
  }

  const codigo = randomBytes(16).toString("hex");
  try {
    // La baja y su constancia (con este código) entran en una sola sentencia.
    const bajas = await bajaDeWaba({ fbUserId: pedido.userId }, "meta", codigo);
    // Sin coincidencia puede ser que no hubiera nada que borrar, o que el id del pedido no sea el que
    // guardamos (el popup no lo informó): la respuesta es la misma, pero el rastro deja verlo.
    if (bajas.length === 0) logger.warn({ codigo }, "meta_borrado.sin_coincidencia");
    logger.info({ codigo, bajas: bajas.length }, "meta_borrado.atendido");
  } catch (err) {
    // Un 500 y no un código: Meta reintenta, y un código sin baja haría creer que se borró.
    logger.error({ code: errorCode(err) }, "meta_borrado.fallo");
    return falla(500, "DELETION_FAILED", "Could not process the deletion request.");
  }

  return NextResponse.json({ url: `${resolveBaseURL()}/privacy#meta`, confirmation_code: codigo });
}
