/**
 * Mandar un mensaje de prueba para comprobar que el sistema puede enviar.
 *
 * Es la única capa de la suite que prueba que un mensaje sale del edificio: lo
 * demás verifica que el código llama a quien tiene que llamar, y esto verifica
 * que del otro lado alguien lo recibe. Por eso el destinatario es una dirección
 * real y no puede dejar de serlo — bloquearla convertiría el chequeo en un
 * tilde verde que no prueba nada.
 *
 * Esto vivía adentro del route handler. Sale acá por lo de siempre —un handler
 * es el borde HTTP, no el lugar donde se manda un mail— y por una razón más
 * concreta: el envío real es exactamente lo que un test quiere reemplazar, y
 * mientras estaba adentro del archivo de la ruta no había cómo.
 */

import "server-only";

/** Los dos canales por los que el producto puede hablarle a alguien. */
export type CanalDeEntrega = "email" | "whatsapp";

export interface ResultadoDeEntrega {
  ok: boolean;
  detail: string;
}

/**
 * El texto, fijo acá.
 *
 * Quien llama elige a QUIÉN, nunca QUÉ. Es lo que impide que el endpoint sirva
 * para algo si alguien se hace del secreto: puede hacer que le llegue a alguien
 * un mensaje que se anuncia como prueba, y nada más.
 */
export function cuerpoDePrueba(ahora: Date = new Date()): string {
  const sello = ahora.toISOString().replace("T", " ").slice(0, 16);
  return (
    `Prueba de entrega de ClaimMix — ${sello}. ` +
    `Es un mensaje automático para verificar que el sistema puede enviar. ` +
    `No hace falta que contestes.`
  );
}

/**
 * El destinatario, reconocible pero no guardado entero.
 *
 * Va al registro de auditoría. Hasta ahora no se guardaba nada: quedaba
 * asentado que se había mandado una prueba, pero no a quién, así que ante «me
 * llegó un mail de ustedes y no sé por qué» no había forma de responder. Y
 * guardar la dirección completa tampoco corresponde — el resto del producto
 * tampoco lo hace, `dispatch.ts` asienta un pedazo del asunto y nada más.
 *
 * Alcanza con poder decir «sí, fuiste vos» o «no, no fuiste vos».
 */
export function enmascararDestinatario(
  canal: CanalDeEntrega,
  destinatario: string
): string {
  if (canal === "whatsapp") {
    const digitos = destinatario.replace(/\D/g, "");
    return digitos.length <= 4 ? "…" : `…${digitos.slice(-4)}`;
  }

  const arroba = destinatario.lastIndexOf("@");
  if (arroba <= 0) return "…";
  const usuario = destinatario.slice(0, arroba);
  const dominio = destinatario.slice(arroba);
  return `${usuario[0]}${"*".repeat(Math.max(usuario.length - 1, 1))}${dominio}`;
}

/**
 * Manda una prueba y cuenta qué dijo el proveedor.
 *
 * @param tenantId de qué aseguradora sale. Lo decide quien llama —hoy, un solo
 *   lugar, a partir de `GMAIL_TENANT_ID`— y no se lee acá adentro: una función
 *   que averigua sola de qué casilla mandar es una función que puede mandar
 *   desde cualquiera.
 */
export async function probarEntrega(
  canal: CanalDeEntrega,
  tenantId: string,
  destinatario: string
): Promise<ResultadoDeEntrega> {
  return canal === "whatsapp"
    ? enviarPorWhatsApp(destinatario)
    : enviarPorCorreo(tenantId, destinatario);
}

async function enviarPorWhatsApp(destinatario: string): Promise<ResultadoDeEntrega> {
  const { sendWhatsAppText } = await import("@/server/whatsapp/cloud-api");
  const res = await sendWhatsAppText(destinatario, cuerpoDePrueba());
  return res.ok
    ? { ok: true, detail: "Meta lo aceptó y lo puso en camino" }
    : { ok: false, detail: res.error ?? "falló el envío" };
}

async function enviarPorCorreo(
  tenantId: string,
  destinatario: string
): Promise<ResultadoDeEntrega> {
  const { getGmailAccountForTenant } = await import("@/server/email/gmail/accounts");
  const account = await getGmailAccountForTenant(tenantId);
  if (!account) {
    return { ok: false, detail: "ninguna casilla conectada, o el token no descifra" };
  }

  const { GmailSender } = await import("@/server/email/gmail/gmail-sender");
  const result = await new GmailSender(account.refreshToken).send({
    to: destinatario,
    from: account.email,
    subject: "Prueba de entrega de ClaimMix",
    textBody: cuerpoDePrueba(),
  });

  if ("providerMessageId" in result && result.providerMessageId) {
    return { ok: true, detail: `enviado desde ${account.email}` };
  }

  // Casi siempre un refresh token revocado por un cambio de contraseña.
  return {
    ok: false,
    detail:
      ("errorCode" in result && result.errorCode) ||
      "falló el envío; puede que haya que reconectar la casilla",
  };
}
