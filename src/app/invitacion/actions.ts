/**
 * Server Actions de /invitacion: aceptar con Google, con una contraseña, con la
 * sesión que ya tiene la persona, o rechazar.
 *
 * Hasta acá nadie escribió nada: el enlace lleva sellado todo y recién una
 * aceptación crea la cuenta (si no existía) y el perfil. Cada acción vuelve a
 * abrir el token del formulario —el campo oculto no es de fiar— y aceptar vuelve
 * a mirar en la base que quien invitó siga siendo admin (ver `aceptarInvitacion`).
 *
 * Con Google la cuenta nace en la vuelta, por el gancho de alta, que reconoce la
 * cookie `cm_invitacion`; el perfil se crea cuando la persona, de vuelta en
 * /invitacion con la sesión ya abierta, aprieta «Aceptar». Con contraseña el
 * enlace prueba la casilla, así que el correo se marca verificado en el mismo paso.
 *
 * Si la dirección ya tenía cuenta se la manda a entrar, y la cookie la trae de
 * vuelta: /pendiente la lleva a /invitacion en lugar de a crear un espacio propio.
 * Si el espacio exige el SSO para ese dominio, ni la contraseña ni Google se
 * aceptan (la pantalla ya no los ofrece) y la sesión que falle se explica en /login.
 *
 * NOTE: redirect() must NOT be wrapped in try/catch — it throws a special
 * Next.js internal error to trigger the redirect.
 */

"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AuditEvent, ipValida, writeAuditLog } from "@/lib/audit/log";
import { auth } from "@/lib/auth";
import { marcarCorreoVerificado } from "@/lib/auth/on-password-reset";
import { enAlta } from "@/lib/auth/registro-permitido";
import { getSessionContext } from "@/lib/auth/session";
import { getUserRowOrThrow } from "@/lib/auth/user-row";
import { logger } from "@/lib/observability/logger";
import { clientIpFromHeaders, topePorIp } from "@/lib/rate-limit/index";
import {
  abrirInvitacion,
  aceptarInvitacion,
  borrarCookieDeInvitacion,
  ponerCookieDeInvitacion,
  resumenDeInvitacion,
  type DatosDeInvitacion,
} from "@/server/alta/invitacion";
import { CODIGO_SSO_REQUERIDO } from "@/server/sso/exigir";

/** Largos de la contraseña que acepta Better Auth. */
const CLAVE_MINIMA = 8;
const CLAVE_MAXIMA = 128;

const YA_TENES_CUENTA = "/login?aviso=ya_tenes_cuenta";
const ERROR_DE_GOOGLE = "/login?error=google_signin_failed";

/** Sin enlace válido la pantalla dice «invitación vencida». */
const SIN_ENLACE = "/invitacion";

const conMotivo = (crudo: string, e?: "clave" | "distintas" | "intentos" | "falla") =>
  `/invitacion?t=${encodeURIComponent(crudo)}${e ? `&e=${e}` : ""}`;

/** Deja el enlace en la cookie para que, después de entrar, /pendiente vuelva a la invitación. */
async function aEntrarYVolver(crudo: string): Promise<string> {
  await ponerCookieDeInvitacion(crudo);
  return YA_TENES_CUENTA;
}

/** El token del formulario, ya abierto, y el valor crudo para volver a la pantalla. Null si no sirve. */
function invitacionDelFormulario(formData: FormData): { crudo: string; datos: DatosDeInvitacion } | null {
  const crudo = formData.get("t");
  const datos = abrirInvitacion(crudo);
  return datos && typeof crudo === "string" ? { crudo, datos } : null;
}

const mismaDireccion = (a: string, b: string) => a.trim().toLowerCase() === b;

/** La ruta de Google, o el error. Nunca redirige: de eso se ocupa quien la llama, fuera de todo try/catch. */
async function destinoDeGoogle(formData: FormData): Promise<string> {
  const invitacion = invitacionDelFormulario(formData);
  if (!invitacion) return SIN_ENLACE;
  const { crudo, datos } = invitacion;

  const headerStore = await headers();
  if (!(await topePorIp(clientIpFromHeaders(headerStore))).allowed) return conMotivo(crudo, "intentos");

  try {
    const resumen = await resumenDeInvitacion(datos);
    if (!resumen || resumen.exigeSso) return conMotivo(crudo);
    await ponerCookieDeInvitacion(crudo);
    const resultado = await auth.api.signInSocial({
      body: {
        provider: "google",
        callbackURL: "/invitacion",
        newUserCallbackURL: "/invitacion",
        // Sin query propia: Better Auth le agrega el código y un parámetro repetido llega como array.
        errorCallbackURL: "/login",
        loginHint: datos.e,
      },
      headers: headerStore,
    });
    if (resultado.url) return resultado.url;
  } catch (e) {
    logger.error({ detalle: e instanceof Error ? e.message : String(e) }, "auth.google.signin_start_failed");
  }
  return ERROR_DE_GOOGLE;
}

export async function aceptarConGoogle(formData: FormData): Promise<void> {
  redirect(await destinoDeGoogle(formData));
}

/** La ruta a la que sigue quien acepta con una contraseña nueva. Nunca redirige. */
async function destinoDeClave(formData: FormData): Promise<string> {
  const invitacion = invitacionDelFormulario(formData);
  if (!invitacion) return SIN_ENLACE;
  const { crudo, datos } = invitacion;

  const password = formData.get("password");
  if (typeof password !== "string" || password.length < CLAVE_MINIMA || password.length > CLAVE_MAXIMA) {
    return conMotivo(crudo, "clave");
  }
  if (password !== formData.get("repetir")) return conMotivo(crudo, "distintas");

  const headerStore = await headers();
  const ip = clientIpFromHeaders(headerStore);
  if (!(await topePorIp(ip)).allowed) return conMotivo(crudo, "intentos");

  // Antes de crear nada: una invitación que ya no sirve, o de un espacio que exige el SSO, no deja una cuenta sin espacio.
  try {
    const resumen = await resumenDeInvitacion(datos);
    if (!resumen || resumen.exigeSso) return conMotivo(crudo);
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "invitacion.resumen_no_leido");
    return conMotivo(crudo, "falla");
  }

  let userId: string;
  try {
    const creada = await enAlta("invitacion", () =>
      auth.api.signUpEmail({
        body: { name: datos.n, email: datos.e, password },
        // Sin cookies: la sesión se abre abajo, cuando la cuenta ya tiene el correo verificado.
        headers: new Headers(),
      })
    );
    userId = creada.user.id;
    // Con `autoSignIn: false` Better Auth contesta igual, con un usuario de mentira, si el correo ya tenía cuenta.
    const { internalAdapter } = await auth.$context;
    if (!(await internalAdapter.findUserById(userId))) return await aEntrarYVolver(crudo);
  } catch (e) {
    const code = e instanceof APIError ? e.body?.code : undefined;
    if (code === "USER_ALREADY_EXISTS") return await aEntrarYVolver(crudo);
    logger.error({ detalle: code ?? (e instanceof Error ? e.name : "unknown") }, "invitacion.cuenta_no_creada");
    return conMotivo(crudo, "falla");
  }

  await marcarCorreoVerificado(userId);

  let aceptada = false;
  try {
    aceptada = await aceptarInvitacion(datos, {
      userId,
      ip: ipValida(ip),
      ua: headerStore.get("user-agent"),
    });
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "invitacion.aceptar_fallo");
  }

  // Con o sin perfil la persona ya tiene cuenta: entra, y la pantalla le dice qué pasó.
  try {
    await auth.api.signInEmail({ body: { email: datos.e, password }, headers: headerStore });
  } catch (e) {
    logger.error({ detalle: e instanceof Error ? e.name : "unknown" }, "invitacion.sin_sesion");
    // El espacio puede haber empezado a exigir el SSO entre que se abrió el enlace y se aceptó.
    return e instanceof APIError && e.body?.code === CODIGO_SSO_REQUERIDO
      ? `/login?error=${CODIGO_SSO_REQUERIDO}`
      : "/login";
  }

  if (!aceptada) return conMotivo(crudo, "falla");
  await borrarCookieDeInvitacion();
  return "/bandeja";
}

export async function aceptarConClave(formData: FormData): Promise<void> {
  redirect(await destinoDeClave(formData));
}

/** La ruta a la que sigue quien acepta con la sesión que ya tiene. Nunca redirige. */
async function destinoDeSesion(formData: FormData): Promise<string> {
  const invitacion = invitacionDelFormulario(formData);
  if (!invitacion) return SIN_ENLACE;
  const { crudo, datos } = invitacion;

  const usuario = (await getSessionContext())?.user;
  // La pantalla explica por qué no; acá sólo se vuelve a ella.
  if (!usuario || !mismaDireccion(usuario.email, datos.e) || usuario.emailVerified !== true) return conMotivo(crudo);

  const headerStore = await headers();
  const ip = clientIpFromHeaders(headerStore);
  if (!(await topePorIp(ip)).allowed) return conMotivo(crudo, "intentos");

  let aceptada: boolean;
  try {
    if ((await getUserRowOrThrow(usuario.id)) !== null) return conMotivo(crudo);
    aceptada = await aceptarInvitacion(datos, {
      userId: usuario.id,
      ip: ipValida(ip),
      ua: headerStore.get("user-agent"),
    });
  } catch (e) {
    logger.error({ error: e instanceof Error ? e.name : "UnknownError" }, "invitacion.aceptar_fallo");
    return conMotivo(crudo, "falla");
  }

  if (!aceptada) return conMotivo(crudo);
  await borrarCookieDeInvitacion();
  return "/bandeja";
}

export async function aceptarConSesion(formData: FormData): Promise<void> {
  redirect(await destinoDeSesion(formData));
}

/**
 * Rechazar no escribe más que el asiento de auditoría del espacio, y sólo con un
 * enlace válido. Sin enlace, o con el tope de la IP agotado, igual se borra la
 * cookie y se muestra «rechazada»: desde afuera no se distingue.
 */
async function destinoDeRechazo(formData: FormData): Promise<string> {
  await borrarCookieDeInvitacion();
  const invitacion = invitacionDelFormulario(formData);
  if (invitacion) {
    const headerStore = await headers();
    const ip = clientIpFromHeaders(headerStore);
    if ((await topePorIp(ip)).allowed) {
      await writeAuditLog({
        tenant_id: invitacion.datos.t,
        event_type: AuditEvent.INVITATION_REJECTED,
        payload: { motivo: "rechazada" },
        ip,
        ua: headerStore.get("user-agent"),
      });
    }
  }
  return "/invitacion?e=rechazada";
}

export async function rechazarInvitacion(formData: FormData): Promise<void> {
  redirect(await destinoDeRechazo(formData));
}
