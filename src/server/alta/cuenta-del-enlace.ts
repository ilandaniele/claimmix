/**
 * Crea la cuenta de quien volvió del enlace del mail de «Activar tu cuenta».
 *
 * Hasta acá /registro no escribió nada: la cuenta nace ahora, con la contraseña
 * que la persona acaba de elegir. Que abriera el enlace prueba que la casilla es
 * suya, así que el correo se marca verificado en el mismo paso. El espacio no se
 * crea acá: la persona sigue a /alta, con la sesión ya abierta, y dice qué vino a
 * hacer (dar de alta su empresa o entrar a una que ya usa ClaimMix).
 *
 * El enlace no se gasta: abrirlo dos veces da los mismos datos. La segunda vez la
 * cuenta ya existe, y `signUpEmail` contesta con un usuario de mentira (ver
 * abajo), que se reconoce porque no está en la base. Quien llega así va a
 * «ya tenés cuenta» y no se le cambia nada.
 *
 * Es un módulo de servidor y no una acción: un archivo con "use server" publica
 * todos sus exports como endpoints, y esto no debe poder llamarse desde afuera.
 * Devuelve la ruta a la que sigue el pedido y nunca redirige: de eso se ocupa
 * quien lo llama, fuera de todo try/catch.
 */

import "server-only";

import { APIError } from "better-auth/api";

import { auth } from "@/lib/auth";
import { marcarCorreoVerificado } from "@/lib/auth/on-password-reset";
import { altaAbierta, enAlta } from "@/lib/auth/registro-permitido";
import { logger } from "@/lib/observability/logger";
import { clientIpFromHeaders, topePorIp } from "@/lib/rate-limit/index";
import { abrirToken } from "@/server/alta/token-de-registro";

/** Largos de la contraseña que acepta Better Auth. */
const CLAVE_MINIMA = 8;
const CLAVE_MAXIMA = 128;

export const YA_TENES_CUENTA = "/login?aviso=ya_tenes_cuenta";

/** Vuelve a la pantalla del enlace con el motivo; el token ya se abrió, así que se puede devolver tal cual. */
const conMotivo = (enlace: string, e: "clave" | "distintas" | "intentos" | "falla") => `${enlace}&e=${e}`;

export async function crearCuentaDelEnlace({
  token: crudo,
  clave,
  repetida,
  headerStore,
}: {
  token: unknown;
  clave: unknown;
  repetida: unknown;
  headerStore: Headers;
}): Promise<string> {
  const token = abrirToken(crudo);
  // Sin `t`, la pantalla dice «enlace vencido».
  if (!token) return "/alta/correo";
  const enlace = `/alta/correo?t=${String(crudo)}`;

  if (typeof clave !== "string" || clave.length < CLAVE_MINIMA || clave.length > CLAVE_MAXIMA) {
    return conMotivo(enlace, "clave");
  }
  if (clave !== repetida) return conMotivo(enlace, "distintas");

  // Este camino no pasa por el gancho de Google: el cierre del alta se mira acá.
  if (!altaAbierta(token.e)) return "/login?error=registro_cerrado";

  const porIp = await topePorIp(clientIpFromHeaders(headerStore));
  if (!porIp.allowed) return conMotivo(enlace, "intentos");

  let userId: string;
  try {
    const creada = await enAlta("correo", () =>
      auth.api.signUpEmail({
        body: { name: token.nombre, email: token.e, password: clave },
        // Sin cookies: la sesión se abre abajo, cuando la cuenta ya tiene el correo verificado.
        headers: new Headers(),
      })
    );
    userId = creada.user.id;
    /*
     * Con `autoSignIn: false` Better Auth contesta igual —con un usuario de
     * mentira y un id al azar— cuando el correo ya tenía cuenta. Que la cuenta
     * esté en la base es lo único que dice que se creó ahora.
     */
    const { internalAdapter } = await auth.$context;
    if (!(await internalAdapter.findUserById(userId))) return YA_TENES_CUENTA;
  } catch (e) {
    const code = e instanceof APIError ? e.body?.code : undefined;
    if (code === "USER_ALREADY_EXISTS") return YA_TENES_CUENTA;
    logger.error({ detalle: code ?? (e instanceof Error ? e.name : "unknown") }, "alta.correo_cuenta_no_creada");
    return conMotivo(enlace, "falla");
  }

  await marcarCorreoVerificado(userId);

  try {
    await auth.api.signInEmail({ body: { email: token.e, password: clave }, headers: headerStore });
  } catch (e) {
    logger.error({ detalle: e instanceof Error ? e.name : "unknown" }, "alta.correo_sin_sesion");
    return "/login";
  }

  return "/alta";
}
