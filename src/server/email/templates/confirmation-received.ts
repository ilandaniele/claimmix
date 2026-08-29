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

export interface ConfirmationReceivedData {
  caseId: string;
  claimType?: string | null;
  policyNumber?: string | null;
  /** True when we have already written to this claimant about this case. */
  isFollowUp?: boolean;
}

export function renderConfirmationReceived(data: ConfirmationReceivedData): {
  subject: string;
  html: string;
  text: string;
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

  const openingHtml = followUp
    ? `Gracias, ya tenemos todo lo que necesitábamos. Tu reclamo${claimPhraseHtml} quedó completo y pasa a análisis.`
    : `Gracias por contactarnos. Registramos exitosamente tu reclamo${claimPhraseHtml}.`;
  const openingText = followUp
    ? `Gracias, ya tenemos todo lo que necesitábamos. Tu reclamo${claimPhraseText} quedó completo y pasa a análisis.`
    : `Gracias por contactarnos. Registramos exitosamente tu reclamo${claimPhraseText}.`;

  const nextStep = followUp
    ? "Un analista lo va a revisar y te contactamos si hiciera falta algo más."
    : "Nuestro equipo analizará tu solicitud y te contactará a la brevedad para darte novedades o solicitarte información adicional si fuera necesaria.";

  const closing = followUp
    ? "Si querés agregar algo más sobre el siniestro, respondé este correo."
    : "Podés responder a este correo si tenés alguna consulta o si querés agregar más información sobre el siniestro.";

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family: Arial, sans-serif; color: #222; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 20px; color: #1a56db;">${heading}</h1>
  <p>${openingHtml}</p>
  <p>Tu número de caso es: <strong>#${escapeHtml(data.caseId)}</strong></p>
  ${policyLine}
  <p>${nextStep}</p>
  <p>${closing}</p>
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
  <p style="font-size: 12px; color: #6b7280;">Este mensaje fue generado automáticamente por el sistema de gestión de siniestros de ClaimMix. Por favor no respondas si recibiste este correo por error.</p>
</body>
</html>`;

  const text = `${heading}\n\n${openingText}\n\nTu número de caso es: #${data.caseId}\n${policyLineText}\n${nextStep}\n\n${closing}\n\n---\nEste mensaje fue generado automáticamente por el sistema de gestión de siniestros de ClaimMix.`;

  return { subject, html, text };
}
