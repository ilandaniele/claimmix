/**
 * Server Action de /alta: crea el espacio de quien se dio de alta sola.
 *
 * El orden es el que no regala nada: primero lo que se mira sin gastar cupos
 * (sesión, correo verificado, que no sea de operación, que el alta esté abierta
 * para esa dirección, que no tenga ya espacio, que los datos valgan), después el
 * cupo por IP, y recién entonces la función de la base. Quien ya tiene espacio
 * vuelve a /bandeja sin tocar ningún contador, y lo que se libera es SÓLO lo que
 * esta llamada tomó. El tope global de 24 h no se cuenta acá: lo cuenta la base.
 *
 * NOTE: redirect() must NOT be wrapped in try/catch — it throws a special
 * Next.js internal error to trigger the redirect.
 */

"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ipValida } from "@/lib/audit/log";
import { altaAbierta } from "@/lib/auth/registro-permitido";
import { isOperatorEmail } from "@/lib/auth/require-operator";
import { getSessionContext } from "@/lib/auth/session";
import { getUserRowOrThrow } from "@/lib/auth/user-row";
import { logger } from "@/lib/observability/logger";
import { clientIpFromHeaders } from "@/lib/rate-limit/index";
import { borrarCookieDeAlta } from "@/server/alta/cookie";
import { crearInquilino, type AltaCreada } from "@/server/alta/crear-inquilino";
import { soltarCupoDeAlta, tomarCupoDeAlta } from "@/server/alta/cupo-por-ip";
import { avisarSiLlegoAlTope, conError, SIN_ESPACIO } from "@/server/alta/destinos";
import { normalizarE164, validarEmpresa } from "@/server/alta/validar";

/** La ruta a la que sigue el pedido. Nunca redirige: de eso se ocupa quien la llama, fuera de todo try/catch. */
async function destinoDelAlta(formData: FormData): Promise<string> {
  const usuario = (await getSessionContext())?.user;
  if (!usuario) return "/login";

  // La pantalla dice por qué no; acá sólo se vuelve a ella.
  if (usuario.emailVerified !== true || isOperatorEmail(usuario.email) || !altaAbierta(usuario.email)) {
    return "/alta";
  }

  let tienePerfil: boolean;
  try {
    tienePerfil = (await getUserRowOrThrow(usuario.id)) !== null;
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "alta.perfil_no_leido");
    return conError("falla");
  }
  if (tienePerfil) return "/bandeja";

  const empresa = validarEmpresa(formData.get("empresa"));
  const numero = normalizarE164(formData.get("whatsapp"));
  if (!empresa.ok || numero === null || formData.get("terminos") !== "on") return conError("datos");

  const ip = clientIpFromHeaders(await headers());
  const { clave, cupo } = await tomarCupoDeAlta(ip);
  // `ventana: 0` es que el contador no contestó: no hubo «demasiados intentos».
  if (!cupo.allowed) return conError(cupo.ventana === 0 ? "falla" : "intentos");

  let alta: AltaCreada;
  try {
    alta = await crearInquilino({
      userId: usuario.id,
      empresa: empresa.empresa,
      numero,
      ip: ipValida(ip),
    });
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "alta.crear_inquilino_fallo");
    await soltarCupoDeAlta(clave, cupo.ventana);
    return conError("falla");
  }

  if (alta.resultado !== "ok" && alta.resultado !== "ok_numero_en_revision") {
    if (alta.resultado === "alta_cerrada") {
      logger.warn({ creadas24h: alta.creadas24h, tope: alta.tope }, "alta.cerrada");
    }
    await soltarCupoDeAlta(clave, cupo.ventana);
    return SIN_ESPACIO[alta.resultado];
  }

  // Los dos resultados dicen lo mismo: no se confirma que el número ya lo había pedido otro.
  await borrarCookieDeAlta();
  avisarSiLlegoAlTope(alta);
  return "/bandeja?bienvenida=1";
}

export async function crearMiEspacio(formData: FormData): Promise<void> {
  redirect(await destinoDelAlta(formData));
}
