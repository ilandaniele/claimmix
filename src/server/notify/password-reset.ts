/**
 * El mail con el enlace para volver a entrar.
 *
 * Hasta ahora no había forma de recuperar una contraseña: hacía falta que un
 * admin la cambiara a mano. Eso es una puerta cerrada con la llave adentro —y,
 * peor, empuja a la práctica de mandar contraseñas por chat.
 *
 * Deliberadamente separado de `dispatchOutboundEmail`, por lo mismo que el
 * aviso a especialistas: ese camino escribe en `claim_messages` e hila el
 * mensaje dentro de la conversación de un asegurado. Esto no es parte de
 * ninguna denuncia; es correo interno para alguien que trabaja acá.
 *
 * Nunca lanza. Better Auth responde siempre lo mismo —«si ese correo existe, te
 * llega un enlace»— justamente para no confirmarle a nadie qué direcciones hay
 * registradas, y una excepción acá rompería esa simetría: el que existe tarda y
 * falla distinto del que no. Si el mail no sale, queda anotado del lado nuestro.
 *
 * **El enlace y el token no se registran en ningún lado.** Un enlace de
 * recuperación ES la credencial mientras dura: quien lo lee entra. Anotarlo en
 * un log lo deja en un lugar donde no vence y donde mira más gente que la
 * dueña de la cuenta.
 *
 * **El saludo no lleva nombre.** El nombre lo escribe quien administra la
 * cuenta, y un mail de la plataforma con texto de un tercero es un mail de
 * phishing con nuestro remitente.
 */

import "server-only";

import { headers } from "next/headers";

import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { filaDeUsuario } from "@/lib/auth/fila-de-usuario-cacheada";
import { getT, type Locale } from "@/lib/i18n";
import { logger } from "@/lib/observability/logger";
import { clientIpFromHeaders } from "@/lib/rate-limit/index";
import { getGmailAccountForTenant } from "@/server/email/gmail/accounts";
import { GmailSender } from "@/server/email/gmail/gmail-sender";
import { isSendSuccess } from "@/server/email/provider";
import { correoDeEnlace } from "./correos-de-alta";
import {
  enviarCorreoDelSistema,
  remitenteDelSistema,
  type CorreoDelSistema,
  type ResultadoDeCorreo,
} from "./remitente-sistema";

export interface PasswordResetEmail {
  /** A quién. */
  email: string;
  /** Better Auth lo pasa, pero no se usa: ver el saludo arriba. */
  name?: string | null;
  /** El id de Better Auth, con el que se averigua de qué aseguradora es. */
  userId: string;
  /** El enlace, ya armado por Better Auth, con el token adentro. */
  url: string;
  /** Cuánto dura, en minutos, para poder decírselo. */
  duraMinutos: number;
  /** El pedido que originó el mail, si Better Auth lo tiene; sin él se lee de las cabeceras de la solicitud en curso. */
  request?: Request;
}

type Envio = ResultadoDeCorreo | { enviado: false; motivo: "sin_casilla" };

/**
 * El camino de antes, para los inquilinos que no son de alta automática,
 * mientras no haya remitente del sistema: sale por la casilla conectada de la
 * aseguradora, que es la que ya usa el producto para hablar con sus asegurados.
 * Así producción no se queda sin recuperación en el medio de la transición.
 */
async function porLaCasillaDelInquilino(
  tenantId: string,
  to: string,
  correo: Omit<CorreoDelSistema, "to">
): Promise<Envio> {
  const account = await getGmailAccountForTenant(tenantId);
  if (!account) {
    logger.error({
      tenant_id: tenantId,
      nota: "Nadie puede recuperar su contraseña en esta aseguradora hasta que haya una casilla conectada.",
    }, "password_reset.sin_casilla");
    return { enviado: false, motivo: "sin_casilla" };
  }

  const result = await new GmailSender(account.refreshToken).send({
    to,
    from: account.email,
    subject: correo.asunto,
    textBody: correo.texto,
  });
  return isSendSuccess(result) ? { enviado: true } : { enviado: false, motivo: "no_salio" };
}

/** Quién pidió el enlace, para contar el cupo por dirección por IP. Nunca lanza: fuera de una solicitud no hay cabeceras. */
async function ipDelPedido(request?: Request): Promise<string> {
  try {
    return clientIpFromHeaders(request ? request.headers : await headers());
  } catch {
    return "anonymous";
  }
}

/**
 * Manda el enlace, si se puede.
 *
 * De qué casilla sale: la de la plataforma (`remitente-sistema.ts`), con sus
 * topes. Sin ella configurada, sólo los inquilinos que no son de alta
 * automática siguen por su propia casilla; una cuenta sin perfil o de una
 * prueba no recibe nada, y queda el log.
 */
export async function sendPasswordResetEmail(
  input: PasswordResetEmail
): Promise<void> {
  try {
    const perfil = await filaDeUsuario(input.userId);
    const locale: Locale = perfil?.locale === "en-US" ? "en-US" : "es-AR";
    // Sin perfil es una cuenta de alta sin contraseña: el enlace la activa.
    const correo = correoDeEnlace(getT(locale), perfil ? "recuperar" : "activar", input.url, input.duraMinutos);

    const envio: Envio =
      perfil && !perfil.autoalta && !remitenteDelSistema()
        ? await porLaCasillaDelInquilino(perfil.tenant_id, input.email, correo)
        : await enviarCorreoDelSistema(
            { to: input.email, ...correo },
            // Sin perfil el enlace activa una cuenta de alta, y es del cupo de las altas.
            { tipo: perfil ? "recuperacion" : "alta", ip: await ipDelPedido(input.request) }
          );

    /*
     * Queda asentado igual, con `delivered: false`.
     *
     * El registro de auditoría es donde se mira cuando alguien pregunta qué
     * pasó con una cuenta. «Pidió recuperar y no salió nada» es exactamente
     * lo que hay que poder ver ahí; si sólo queda en los logs del servidor,
     * la respuesta a esa pregunta es «no hay nada», que suena a que no pidió.
     * Sin perfil no hay inquilino a quien anotárselo: queda el log.
     */
    if (perfil) {
      await writeAuditLog({
        tenant_id: perfil.tenant_id,
        actor_id: null,
        event_type: AuditEvent.PASSWORD_RESET_REQUESTED,
        target_type: "user",
        target_id: input.userId,
        // Ni la dirección ni el enlace: que se pidió, si salió y, si no, por qué.
        payload: envio.enviado
          ? { delivered: true }
          : { delivered: false, motivo: envio.motivo },
      });
    }

    logger.info({
        user_id: input.userId,
      }, envio.enviado ? "password_reset.sent" : "password_reset.send_failed");
  } catch (err) {
    logger.error({
        error: err instanceof Error ? err.name : "UnknownError",
      }, "password_reset.error");
  }
}
