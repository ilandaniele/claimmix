import "server-only";

import { APIError } from "better-auth/api";

import { dominioDelMail } from "@/core/sso";
import { logger } from "@/lib/observability/logger";
import {
  altaAbierta,
  altaEnCursoPorServidor,
  ingresoPorSso,
} from "@/lib/auth/registro-permitido";
import { abrirInvitacion, COOKIE_DE_INVITACION } from "@/server/alta/invitacion";
import { CODIGO_SSO_REQUERIDO } from "@/server/sso/exigir";
import { dominioExigeSsoEnAlgunInquilino } from "@/server/sso/usuarios";

export type CaminoDeAlta = "sso" | "correo" | "invitacion" | "google";

export const CODIGO_REGISTRO_CERRADO = "registro_cerrado";

/** Lo que el gancho de better-auth le pasa a `before`: la ruta del pedido y sus cookies. */
type ContextoDelPedido =
  | { path?: string; getCookie?: (key: string) => string | null }
  | null
  | undefined;

/** La ruta de la vuelta de Google. Es la única entrada pública que puede crear una cuenta sola. */
const RUTA_DE_VUELTA_DE_GOOGLE = "/callback/";

function rechazar(codigo: string, mensaje: string, email: string): never {
  logger.warn(
    { dominio: email.slice(email.lastIndexOf("@") + 1) || "(sin dominio)", motivo: codigo },
    "auth.registro.rechazado"
  );
  // UNPROCESSABLE_ENTITY y no FORBIDDEN: con `autoSignIn: false`, better-auth convierte
  // un 403 de `signUpEmail` en un usuario de mentira con 200, y el alta parecería hecha.
  throw new APIError("UNPROCESSABLE_ENTITY", { code: codigo, message: mensaje });
}

/**
 * Por qué puerta entra esta cuenta nueva, o lanza si por ninguna. Es la única
 * copia de la regla: el gancho `user.create.before` (`index.ts`) la aplica a toda
 * alta, venga del formulario, de Google o del SSO.
 *
 * El orden importa: lo que abre el código del servidor (SSO, alta de correo,
 * invitación con contraseña) va antes que lo que se deduce de la ruta. Un pedido
 * nunca elige el camino; lo elige quien envuelve la llamada.
 *
 * Con un dominio que algún inquilino reserva con «Exigir SSO», ni Google ni el
 * correo crean la cuenta: el gancho de sesión se la negaría y quedaría a medias.
 * La invitación no pasa por esa regla: la cuenta tiene perfil en el espacio que
 * invita, y sólo ese espacio puede exigirle el SSO. Por eso la frena /invitacion
 * (`ResumenDeInvitacion.exigeSso`), no este gancho.
 */
export async function caminoDeAlta(email: string, ctx?: ContextoDelPedido): Promise<CaminoDeAlta> {
  const sso = ingresoPorSso();
  if (sso) {
    // El dominio verificado del inquilino hace de allowlist, y nada más que esa.
    if (dominioDelMail(email) !== sso.dominio) {
      rechazar(CODIGO_REGISTRO_CERRADO, "El registro no está habilitado.", email);
    }
    return "sso";
  }

  const enCurso = altaEnCursoPorServidor();
  if (enCurso === "correo" || enCurso === "invitacion") {
    if (enCurso === "correo" && (await dominioExigeSsoEnAlgunInquilino(email))) {
      rechazar(CODIGO_SSO_REQUERIDO, "Tu organización exige entrar con el SSO de la empresa.", email);
    }
    return enCurso;
  }

  if (ctx?.path?.startsWith(RUTA_DE_VUELTA_DE_GOOGLE)) {
    /*
     * Quien aceptó una invitación con Google: la cookie sellada la dejó /invitacion
     * y vale sólo para la dirección invitada, con el alta cerrada o abierta. No
     * crea más que la cuenta: el perfil lo da `aceptarInvitacion`, si quien invitó
     * sigue siendo admin.
     */
    const invitacion = abrirInvitacion(ctx.getCookie?.(COOKIE_DE_INVITACION));
    if (invitacion && invitacion.e === email.trim().toLowerCase()) return "invitacion";

    if (altaAbierta(email)) {
      if (await dominioExigeSsoEnAlgunInquilino(email)) {
        rechazar(CODIGO_SSO_REQUERIDO, "Tu organización exige entrar con el SSO de la empresa.", email);
      }
      return "google";
    }
  }

  return rechazar(CODIGO_REGISTRO_CERRADO, "El registro no está habilitado.", email);
}
