/**
 * Email template: confirmation_received
 *
 * Sent when an inbound email is classified as a valid claim and a case is created.
 * This is always the first reply the claimant receives.
 *
 * AC12: Must reference case_id. Must NOT include raw DNI or full policy_number.
 * AC24: Sensitive fields masked before rendering.
 *
 * Subject: "Recibimos tu reclamo - Caso #{caseId}"
 */

import { labelForClaimType } from "@/lib/labels/claim-fields";
import { maskDni, maskPolicyNumber } from "@/server/email/render";

export interface ConfirmationReceivedData {
  caseId: string;
  claimType?: string | null;
  policyNumber?: string | null;
}

export function renderConfirmationReceived(data: ConfirmationReceivedData): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Recibimos tu reclamo - Caso #${data.caseId}`;
  const claimLabel = labelForClaimType(data.claimType);
  // maskPolicyNumber only keeps digits it can safely show, so a number like
  // POL-4471-A collapses to "****". Printing "Póliza asociada: ****" tells the
  // claimant nothing and reads like the field failed to populate — if the mask
  // left nothing recognizable, the line is worth less than the space it takes.
  const masked = data.policyNumber ? maskPolicyNumber(data.policyNumber) : null;
  const maskedPolicy = masked && /\d/.test(masked) ? masked : null;

  const policyLine = maskedPolicy
    ? `<p>Póliza asociada: <strong>${maskedPolicy}</strong></p>`
    : "";
  const policyLineText = maskedPolicy ? `Póliza asociada: ${maskedPolicy}\n` : "";

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>${subject}</title></head>
<body style="font-family: Arial, sans-serif; color: #222; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 20px; color: #1a56db;">Recibimos tu reclamo</h1>
  <p>Gracias por contactarnos. Registramos exitosamente tu reclamo de <strong>${claimLabel}</strong>.</p>
  <p>Tu número de caso es: <strong>#${data.caseId}</strong></p>
  ${policyLine}
  <p>Nuestro equipo analizará tu solicitud y te contactará a la brevedad para darte novedades o solicitarte información adicional si fuera necesaria.</p>
  <p>Podés responder a este correo si tenés alguna consulta o si querés agregar más información sobre el siniestro.</p>
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
  <p style="font-size: 12px; color: #6b7280;">Este mensaje fue generado automáticamente por el sistema de gestión de siniestros de ClaimMix. Por favor no respondas si recibiste este correo por error.</p>
</body>
</html>`;

  const text = `Recibimos tu reclamo\n\nGracias por contactarnos. Registramos exitosamente tu reclamo de ${claimLabel}.\n\nTu número de caso es: #${data.caseId}\n${policyLineText}\nNuestro equipo analizará tu solicitud y te contactará a la brevedad para darte novedades o solicitarte información adicional si fuera necesaria.\n\nPodés responder a este correo si tenés alguna consulta o si querés agregar más información sobre el siniestro.\n\n---\nEste mensaje fue generado automáticamente por el sistema de gestión de siniestros de ClaimMix.`;

  return { subject, html, text };
}
