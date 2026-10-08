/**
 * Server Action de /alta/correo: crea la cuenta de quien volvió del enlace del
 * mail de «Activar tu cuenta» y le deja el espacio hecho.
 *
 * Hasta acá /registro no escribió nada: la cuenta nace ahora, con la contraseña
 * que la persona acaba de elegir. Que abriera el enlace prueba que la casilla es
 * suya, así que el correo se marca verificado en el mismo paso.
 *
 * El enlace no se gasta: abrirlo dos veces da los mismos datos. La segunda vez la
 * cuenta ya existe, y `signUpEmail` contesta con un usuario de mentira (ver
 * abajo), que se reconoce porque no está en la base. Quien llega así va a
 * «ya tenés cuenta» y no se le cambia nada.
 *
 * Si el alta se cerró, o la base no pudo crear el espacio, la cuenta queda
 * verificada y con sesión pero sin espacio: /alta le deja reintentar sin repetir
 * el correo.
 *
 * NOTE: redirect() must NOT be wrapped in try/catch — it throws a special
 * Next.js internal error to trigger the redirect.
 */

"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ipValida } from "@/lib/audit/log";
import { auth } from "@/lib/auth";
import { marcarCorreoVerificado } from "@/lib/auth/on-password-reset";
import { altaAbierta, enAlta } from "@/lib/auth/registro-permitido";
import { logger } from "@/lib/observability/logger";
import { clientIpFromHeaders, topePorIp } from "@/lib/rate-limit/index";
import { crearInquilino, type AltaCreada } from "@/server/alta/crear-inquilino";
import { soltarCupoDeAlta, tomarCupoDeAlta } from "@/server/alta/cupo-por-ip";
import { avisarSiLlegoAlTope, conError, SIN_ESPACIO } from "@/server/alta/destinos";
import { abrirToken } from "@/server/alta/token-de-registro";

/** Largos de la contraseña que acepta Better Auth. */
const CLAVE_MINIMA = 8;
const CLAVE_MAXIMA = 128;

const YA_TENES_CUENTA = "/login?aviso=ya_tenes_cuenta";

/** Vuelve a la pantalla del enlace con el motivo; el token ya se abrió, así que se puede devolver tal cual. */
const conMotivo = (enlace: string, e: "clave" | "distintas" | "intentos" | "falla") => `${enlace}&e=${e}`;

/** La ruta a la que sigue el pedido. Nunca redirige: de eso se ocupa quien la llama, fuera de todo try/catch. */
async function destinoDelEnlace(formData: FormData): Promise<string> {
  const crudo = formData.get("t");
  const token = abrirToken(crudo);
  // Sin `t`, la pantalla dice «enlace vencido».
  if (!token) return "/alta/correo";
  const enlace = `/alta/correo?t=${String(crudo)}`;

  const password = formData.get("password");
  if (typeof password !== "string" || password.length < CLAVE_MINIMA || password.length > CLAVE_MAXIMA) {
    return conMotivo(enlace, "clave");
  }
  if (password !== formData.get("repetir")) return conMotivo(enlace, "distintas");

  // Este camino no pasa por el gancho de Google: el cierre del alta se mira acá.
  if (!altaAbierta(token.e)) return "/login?error=registro_cerrado";

  const headerStore = await headers();
  const ip = clientIpFromHeaders(headerStore);
  const porIp = await topePorIp(ip);
  if (!porIp.allowed) return conMotivo(enlace, "intentos");

  let userId: string;
  try {
    const creada = await enAlta("correo", () =>
      auth.api.signUpEmail({
        body: { name: token.nombre, email: token.e, password },
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

  // El mismo cupo por red que /alta: sin él, cada enlace abierto sería un espacio más sin tope por día.
  let alta: AltaCreada | null = null;
  const { clave, cupo } = await tomarCupoDeAlta(ip);
  if (cupo.allowed) {
    try {
      alta = await crearInquilino({
        userId,
        empresa: token.empresa,
        numero: token.numero,
        ip: ipValida(ip),
      });
    } catch (e) {
      logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "alta.crear_inquilino_fallo");
    }
    if (alta === null || (alta.resultado !== "ok" && alta.resultado !== "ok_numero_en_revision")) {
      await soltarCupoDeAlta(clave, cupo.ventana);
    }
  }

  // Con o sin espacio la persona ya tiene cuenta: entra, y /alta le deja reintentar.
  try {
    await auth.api.signInEmail({ body: { email: token.e, password }, headers: headerStore });
  } catch (e) {
    logger.error({ detalle: e instanceof Error ? e.name : "unknown" }, "alta.correo_sin_sesion");
    return "/login";
  }

  // `ventana: 0` es que el contador no contestó: no hubo «demasiados intentos».
  if (!cupo.allowed) return conError(cupo.ventana === 0 ? "falla" : "intentos");
  if (alta === null) return conError("falla");
  if (alta.resultado !== "ok" && alta.resultado !== "ok_numero_en_revision") {
    if (alta.resultado === "alta_cerrada") {
      logger.warn({ creadas24h: alta.creadas24h, tope: alta.tope }, "alta.cerrada");
    }
    return SIN_ESPACIO[alta.resultado];
  }

  avisarSiLlegoAlTope(alta);
  return "/bandeja?bienvenida=1";
}

export async function crearCuentaDesdeCorreo(formData: FormData): Promise<void> {
  redirect(await destinoDelEnlace(formData));
}
