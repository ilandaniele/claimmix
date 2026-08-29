
import { escapeHtml } from "@/server/email/render";/**
 * Email template: specialist_escalation
 *
 * Sent when a case is escalated to a specialist due to high or critical severity.
 * Acknowledges the severity, confirms a specialist response within 24h, and
 * provides the case ID for reference.
 *
 * AC11: Sent when severity = 'high' or 'critical' and requires_specialist = true.
 * AC24: No DNI or full policy_number in body.
 *
 * Subject: "Tu reclamo fue escalado a un especialista - Caso #{caseId}"
 */

export interface SpecialistEscalationData {
  caseId: string;
  severity?: "high" | "critical" | string;
}

function severityMessage(severity: string | undefined): string {
  if (severity === "critical") {
    return "Entendemos que tu situación es urgente y requiere atención inmediata.";
  }
  return "Entendemos que tu situación requiere atención especializada.";
}

export function renderSpecialistEscalation(data: SpecialistEscalationData): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Tu reclamo fue escalado a un especialista - Caso #${data.caseId}`;
  const urgencyMsg = severityMessage(data.severity);

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family: Arial, sans-serif; color: #222; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 20px; color: #b91c1c;">Tu reclamo fue asignado a un especialista</h1>
  <p>${urgencyMsg}</p>
  <p>Tu <strong>caso #${escapeHtml(data.caseId)}</strong> fue escalado a uno de nuestros especialistas, quien se comunicará con vos en un plazo máximo de <strong>24 horas hábiles</strong>.</p>
  <p>No es necesario que tomes ninguna acción adicional por el momento. Un especialista revisará en detalle tu situación y te contactará para coordinar los próximos pasos.</p>
  <p>Si tenés información adicional relevante, podés responder a este correo y será incorporada a tu caso.</p>
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
  <p style="font-size: 12px; color: #6b7280;">Caso de referencia: #${escapeHtml(data.caseId)}. Este mensaje fue generado automáticamente por el sistema de gestión de siniestros de ClaimMix.</p>
</body>
</html>`;

  const text = `Tu reclamo fue asignado a un especialista\n\n${urgencyMsg}\n\nTu caso #${data.caseId} fue escalado a uno de nuestros especialistas, quien se comunicará con vos en un plazo máximo de 24 horas hábiles.\n\nNo es necesario que tomes ninguna acción adicional por el momento. Un especialista revisará en detalle tu situación y te contactará para coordinar los próximos pasos.\n\nSi tenés información adicional relevante, podés responder a este correo y será incorporada a tu caso.\n\n---\nCaso de referencia: #${data.caseId}. Este mensaje fue generado automáticamente por el sistema de gestión de siniestros de ClaimMix.`;

  return { subject, html, text };
}
