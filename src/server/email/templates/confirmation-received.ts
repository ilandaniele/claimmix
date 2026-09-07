/**
 * Email template: confirmation_received
 *
 * The message that goes out when there is nothing to ask. That happens at two
 * different moments, and they are not the same message:
 *
 *   - First contact: a claim arrived complete. "Recibimos tu reclamo."
 *   - Closing:       the last question was answered. "Tu reclamo quedó completo."
 *
 * The first arriving third, after two rounds the claimant patiently answered,
 * reads as though the exchange never happened. `isFollowUp` picks which one.
 *
 * AC12: Must reference case_id. Must NOT include raw DNI or full policy_number.
 * AC24: Sensitive fields masked before rendering.
 */

import { labelForClaimType } from "@/lib/labels/claim-fields";
import { escapeHtml, maskPolicyNumber } from "@/server/email/render";
import { textoAHtml } from "@/core/email/html";

export interface ConfirmationReceivedData {
  caseId: string;
  claimType?: string | null;
  policyNumber?: string | null;
  /** True when we have already written to this claimant about this case. */
  isFollowUp?: boolean;
  /**
   * El nombre de pila, cuando el caso ya lo tiene.
   *
   * El orquestador lo mandaba y este armador lo descartaba, así que el producto
   * saludaba por nombre en el mensaje que pide datos y en el siguiente no.
   */
  claimantName?: string | null;
  /** La prosa ya redactada. Reemplaza el cuerpo y nada más. */
  cuerpo?: string | null;
}

export function renderConfirmationReceived(data: ConfirmationReceivedData): {
  subject: string;
  html: string;
  text: string;
  cuerpo: string;
} {
  const followUp = data.isFollowUp === true;

  const subject = followUp
    ? `Tu reclamo quedó completo - Caso #${data.caseId}`
    : `Recibimos tu reclamo - Caso #${data.caseId}`;
  const heading = followUp ? "Tu reclamo quedó completo" : "Recibimos tu reclamo";

  // No type, no phrase. "tu reclamo de siniestro" is a sentence that spends
  // words to say nothing; "Registramos exitosamente tu reclamo." is complete.
  const claimLabel = labelForClaimType(data.claimType);
  const claimPhraseHtml = claimLabel ? ` de <strong>${escapeHtml(claimLabel)}</strong>` : "";
  const claimPhraseText = claimLabel ? ` de ${claimLabel}` : "";

  // maskPolicyNumber only keeps digits it can safely show, so a number like
  // POL-4471-A collapses to "****". Printing "Póliza asociada: ****" tells the
  // claimant nothing and reads like the field failed to populate — if the mask
  // left nothing recognizable, the line is worth less than the space it takes.
  const masked = data.policyNumber ? maskPolicyNumber(data.policyNumber) : null;
  const maskedPolicy = masked && /\d/.test(masked) ? masked : null;

  const policyLine = maskedPolicy
    ? `<p>Póliza asociada: <strong>${escapeHtml(maskedPolicy)}</strong></p>`
    : "";
  const policyLineText = maskedPolicy ? `Póliza asociada: ${maskedPolicy}\n` : "";

  // El nombre delante y la mayúscula en la misma expresión: sin nombre la
  // oración sigue empezando en mayúscula, que es justo lo que se rompía en la
  // otra plantilla cuando el saludo era una cadena vacía.
  const nombre = data.claimantName?.trim();
  const saludo = nombre ? `${nombre}, ` : "";
  const gracias = nombre ? "gracias" : "Gracias";

  const openingHtml = followUp
    ? `${escapeHtml(saludo)}${gracias}, ya tenemos todo lo que necesitábamos. Tu reclamo${claimPhraseHtml} quedó completo y pasa a análisis.`
    : `${escapeHtml(saludo)}${gracias} por contactarnos. Registramos exitosamente tu reclamo${claimPhraseHtml}.`;
  const openingText = followUp
    ? `${saludo}${gracias}, ya tenemos todo lo que necesitábamos. Tu reclamo${claimPhraseText} quedó completo y pasa a análisis.`
    : `${saludo}${gracias} por contactarnos. Registramos exitosamente tu reclamo${claimPhraseText}.`;

  const nextStep = followUp
    ? "Un analista lo va a revisar y te contactamos si hiciera falta algo más."
    : "Nuestro equipo analizará tu solicitud y te contactará a la brevedad para darte novedades o solicitarte información adicional si fuera necesaria.";

  const closing = followUp
    ? "Si querés agregar algo más sobre el siniestro, respondé este correo."
    : "Podés responder a este correo si tenés alguna consulta o si querés agregar más información sobre el siniestro.";

  /*
   * El número de caso y la póliza enmascarada bajan al cromo.
   *
   * Vivían adentro de la prosa, y ésta es una de las dos plantillas donde el
   * número de caso no está repetido en el pie: un cuerpo redactado se lo
   * llevaba puesto. Abajo del todo, pegado a la línea de corte, queda donde ya
   * está en las otras tres.
   */
  const referenciaHtml = `<p>Tu número de caso es: <strong>#${escapeHtml(data.caseId)}</strong></p>
  ${policyLine}`;

  const cuerpo = `${openingText}\n\n${nextStep}\n\n${closing}`;
  const redactado = data.cuerpo?.trim();

  const prosaHtml = redactado
    ? textoAHtml(redactado)
    : `<p>${openingHtml}</p>
  <p>${nextStep}</p>
  <p>${closing}</p>`;

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family: Arial, sans-serif; color: #222; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 20px; color: #1a56db;">${heading}</h1>
  ${prosaHtml}
  ${referenciaHtml}
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
  <p style="font-size: 12px; color: #6b7280;">Este mensaje fue generado automáticamente por el sistema de gestión de siniestros de ClaimMix. Por favor no respondas si recibiste este correo por error.</p>
</body>
</html>`;

  const text = `${heading}\n\n${redactado ?? cuerpo}\n\nTu número de caso es: #${data.caseId}\n${policyLineText}\n---\nEste mensaje fue generado automáticamente por el sistema de gestión de siniestros de ClaimMix.`;

  return { subject, html, text, cuerpo };
}
