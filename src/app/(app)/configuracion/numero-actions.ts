/**
 * Server Actions del panel del número de WhatsApp de /configuracion: pedir el
 * código por SMS o llamada, y entregárselo a Meta.
 *
 * Una action es un POST que cualquiera puede armar a mano, así que cada una
 * pide `requireRole` por su cuenta: que la pantalla no muestre el formulario no
 * es una guarda. Sólo pasa quien es owner o admin de un espacio del alta
 * automática; sin sesión va a /login y el resto a /bandeja.
 *
 * Quién pide (espacio, usuario, IP, idioma) sale de la sesión y de los headers,
 * nunca del cuerpo. Terminan en un `redirect` a `/configuracion?wa=<resultado>`
 * (ver `numero-resultados.ts`): una lista cerrada, nunca texto que venga del
 * pedido ni de Graph. `redirect()` tira un error interno de Next, así que va
 * afuera de todo try/catch.
 */

"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ipValida } from "@/lib/audit/log";
import { ADMIN_ROLES, requireRole } from "@/lib/auth/require-role";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { clientIpFromHeaders } from "@/lib/rate-limit/index";
import { pedirCodigo, verificarCodigo, type QuienPide } from "@/server/alta/numero-automatico";
import type { ResultadoDelNumero } from "@/server/alta/numero-resultados";

const RUTA = "/configuracion";

type Hacer = (quien: QuienPide) => Promise<ResultadoDelNumero>;

/** A dónde sigue el pedido. No redirige: de eso se ocupan las acciones, afuera de todo try/catch. */
async function destino(hacer: Hacer): Promise<string> {
  let quien: QuienPide;
  try {
    const { userRow } = await requireRole(...ADMIN_ROLES);
    if (userRow.autoalta !== true) return "/bandeja";
    quien = {
      tenantId: userRow.tenant_id,
      userId: userRow.id,
      ip: ipValida(clientIpFromHeaders(await headers())),
      idioma: userRow.locale === "en-US" ? "en-US" : "es-AR",
    };
  } catch (e) {
    return e instanceof AppError && e.code === "MISSING_SESSION" ? "/login" : "/bandeja";
  }
  try {
    return `${RUTA}?wa=${await hacer(quien)}`;
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "configuracion.numero_accion_fallo");
    return `${RUTA}?wa=meta`;
  }
}

export async function pedirCodigoDelNumero(form: FormData): Promise<void> {
  const metodo = form.get("metodo") === "VOICE" ? "VOICE" : "SMS";
  redirect(await destino((q) => pedirCodigo(q, metodo)));
}

export async function verificarCodigoDelNumero(form: FormData): Promise<void> {
  // El SMS lo muestra a veces con espacio en el medio («123 456»): se pega tal cual y no cuenta.
  const codigo = String(form.get("codigo") ?? "").replace(/\s+/g, "");
  redirect(await destino((q) => verificarCodigo(q, codigo)));
}
