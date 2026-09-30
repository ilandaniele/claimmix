import "server-only";

import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { logger } from "@/lib/observability/logger";
import { clientIpFromHeaders, RATE_LIMIT_CONFIGS, rateLimit, topePorIp } from "@/lib/rate-limit/index";
import { claveDeCupo } from "@/lib/rate-limit/clave";

/**
 * La dirección del IdP de quien quiere entrar con el SSO de su empresa, o null.
 *
 * `null` es una sola respuesta para todo: dominio sin SSO, sin verificar, IdP
 * caído, dirección mal escrita o demasiados intentos. Quien llama redirige igual
 * en todos los casos, así que desde afuera no se puede averiguar qué
 * aseguradoras usan la plataforma.
 *
 * Los Server Actions llaman a `auth.api` sin pasar por la ruta HTTP, que es donde
 * está el tope por IP. Como el endpoint sale a la red (DNS y el documento del
 * IdP), se aplican acá los mismos dos topes que tiene el ingreso con contraseña.
 */
export async function urlDelSso(
  correo: string,
  callbackURL: string,
  errorCallbackURL: string
): Promise<string | null> {
  const email = correo.trim();
  if (email.length < 3 || email.length > 254) return null;

  const cabeceras = await headers();
  const ip = clientIpFromHeaders(cabeceras);
  const [porCorreo, porIp] = await Promise.all([
    rateLimit(claveDeCupo("auth:sso", ip, email), RATE_LIMIT_CONFIGS.AUTH_SIGN_IN),
    topePorIp(ip),
  ]);
  if (!porCorreo.allowed || !porIp.allowed) return null;

  try {
    const { url } = await auth.api.signInSsoInquilino({
      body: { email, callbackURL, errorCallbackURL },
      headers: cabeceras,
    });
    return url ?? null;
  } catch (e) {
    logger.error({ detalle: e instanceof Error ? e.message : String(e) }, "auth.sso.signin_start_failed");
    return null;
  }
}
