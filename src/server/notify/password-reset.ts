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
 */

import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getGmailAccountForTenant } from "@/server/email/gmail/accounts";
import { GmailSender } from "@/server/email/gmail/gmail-sender";
import { isSendSuccess } from "@/server/email/provider";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

export interface PasswordResetEmail {
  /** A quién. */
  email: string;
  /** Cómo se llama, para no escribirle "Hola null". */
  name?: string | null;
  /** El id de Better Auth, con el que se averigua de qué aseguradora es. */
  userId: string;
  /** El enlace, ya armado por Better Auth, con el token adentro. */
  url: string;
  /** Cuánto dura, en minutos, para poder decírselo. */
  duraMinutos: number;
}

function redactar(input: PasswordResetEmail) {
  const nombre = input.name?.trim().split(/\s+/)[0] ?? null;
  const saludo = nombre ? `Hola ${nombre},` : "Hola,";

  return {
    subject: "Recuperar el acceso a ClaimMix",
    text: [
      saludo,
      "",
      "Alguien pidió volver a entrar a tu cuenta de ClaimMix. Si fuiste vos,",
      "abrí este enlace para poner una contraseña nueva:",
      "",
      input.url,
      "",
      `El enlace vence en ${input.duraMinutos} minutos y sirve una sola vez.`,
      "",
      "Si no fuiste vos, no hace falta que hagas nada: tu contraseña actual",
      "sigue funcionando y este enlace vence solo. Si te llega esto varias",
      "veces sin haberlo pedido, avisale a quien administra tu cuenta.",
    ].join("\n"),
  };
}

/**
 * Manda el enlace, si se puede.
 *
 * De qué casilla sale: la de la aseguradora de esa persona. Es la misma que ya
 * usa el producto para hablar con sus asegurados, así que no hay una segunda
 * configuración de correo que pueda estar mal y no notarse hasta que alguien
 * necesite entrar.
 */
export async function sendPasswordResetEmail(
  input: PasswordResetEmail
): Promise<void> {
  try {
    // sin-inquilino: ésta es la consulta que AVERIGUA de qué inquilino es. Es
    // el mismo arranque que hace el login, y por el mismo motivo: todavía no
    // hay contexto que fijar porque justamente lo estamos buscando.
    const [perfil] = await db
      .select({ tenant_id: users.tenant_id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);

    if (!perfil) {
      /*
       * Cuenta sin perfil: existe en Better Auth y no está atada a ninguna
       * aseguradora. Pasa con quien se dio de alta sin estar en la lista
       * permitida — el alta crea la cuenta y NO crea el perfil, a propósito.
       *
       * No hay casilla desde donde escribirle, y tampoco corresponde: no tiene
       * acceso a nada que recuperar.
       */
      console.warn(
        JSON.stringify({
          level: "warn",
          service: "claimmix",
          msg: "password_reset.sin_perfil",
          // El id y no la dirección: esto es un registro.
          user_id: input.userId,
        })
      );
      return;
    }

    const account = await getGmailAccountForTenant(perfil.tenant_id);
    if (!account) {
      console.error(
        JSON.stringify({
          level: "error",
          service: "claimmix",
          msg: "password_reset.sin_casilla",
          tenant_id: perfil.tenant_id,
          nota: "Nadie puede recuperar su contraseña en esta aseguradora hasta que haya una casilla conectada.",
        })
      );
      /*
       * Queda asentado igual, con `delivered: false`.
       *
       * El registro de auditoría es donde se mira cuando alguien pregunta qué
       * pasó con una cuenta. «Pidió recuperar y no salió nada» es exactamente
       * lo que hay que poder ver ahí; si sólo queda en los logs del servidor,
       * la respuesta a esa pregunta es «no hay nada», que suena a que no pidió.
       */
      await writeAuditLog({
        tenant_id: perfil.tenant_id,
        actor_id: null,
        event_type: AuditEvent.PASSWORD_RESET_REQUESTED,
        target_type: "user",
        target_id: input.userId,
        payload: { delivered: false, motivo: "sin_casilla" },
      });
      return;
    }

    const { subject, text } = redactar(input);
    const sender = new GmailSender(account.refreshToken);
    const result = await sender.send({
      to: input.email,
      from: account.email,
      subject,
      textBody: text,
    });

    const entregado = isSendSuccess(result);

    await writeAuditLog({
      tenant_id: perfil.tenant_id,
      actor_id: null,
      event_type: AuditEvent.PASSWORD_RESET_REQUESTED,
      target_type: "user",
      target_id: input.userId,
      // Ni la dirección ni el enlace: que se pidió y si salió.
      payload: { delivered: entregado },
    });

    console.info(
      JSON.stringify({
        level: entregado ? "info" : "error",
        service: "claimmix",
        msg: entregado ? "password_reset.sent" : "password_reset.send_failed",
        user_id: input.userId,
      })
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "password_reset.error",
        error: err instanceof Error ? err.name : "UnknownError",
      })
    );
  }
}
