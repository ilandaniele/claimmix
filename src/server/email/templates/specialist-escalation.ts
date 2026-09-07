
import { escapeHtml } from "@/server/email/render";
import { textoAHtml } from "@/core/email/html";/**
 * Email template: specialist_escalation
 *
 * Sent when a case is escalated to a specialist due to high or critical severity.
 * Acknowledges the severity, says a specialist is taking over, and provides the
 * case ID for reference.
 *
 * AC11: Sent when severity = 'high' or 'critical' and requires_specialist = true.
 * AC24: No DNI or full policy_number in body.
 *
 * Subject: "Tu reclamo fue escalado a un especialista - Caso #{caseId}"
 *
 * ── Por qué ya no promete 24 horas hábiles ──────────────────────────────────
 *
 * Nadie evaluó el siniestro todavía, así que el plazo era una promesa que este
 * producto no puede hacer — el piso de WhatsApp (`ESCALATION_TEXT`) nunca la
 * hizo. Y desde que el correo pasa por el redactor tenía un costo extra: la
 * reescritura natural de «en un plazo máximo de 24 horas hábiles» es «en 24
 * horas hábiles», que las guardas de `compose-reply` rechazan. Entregar ese
 * piso como «decí esto mejor» era una fábrica de rechazos: dos llamadas al
 * modelo quemadas por escalada para volver a una plantilla que igual prometía.
 */

export interface SpecialistEscalationData {
  caseId: string;
  severity?: "high" | "critical" | string;
  /** La prosa ya redactada. Reemplaza el cuerpo y nada más. */
  cuerpo?: string | null;
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
  cuerpo: string;
} {
  const subject = `Tu reclamo fue escalado a un especialista - Caso #${data.caseId}`;
  const urgencyMsg = severityMessage(data.severity);

  const derivacion =
    "Tu reclamo fue escalado a uno de nuestros especialistas, que se va a comunicar con vos a la brevedad.";
  const sinAccion =
    "No es necesario que tomes ninguna acción adicional por el momento. Un especialista revisará en detalle tu situación y te contactará para coordinar los próximos pasos.";
  const agregar =
    "Si tenés información adicional relevante, podés responder a este correo y será incorporada a tu caso.";

  const cuerpo = `${urgencyMsg}\n\n${derivacion}\n\n${sinAccion}\n\n${agregar}`;
  const redactado = data.cuerpo?.trim();

  const prosaHtml = redactado
    ? textoAHtml(redactado)
    : `<p>${urgencyMsg}</p>
  <p>${escapeHtml(derivacion)}</p>
  <p>${escapeHtml(sinAccion)}</p>
  <p>${escapeHtml(agregar)}</p>`;

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family: Arial, sans-serif; color: #222; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 20px; color: #b91c1c;">Tu reclamo fue asignado a un especialista</h1>
  ${prosaHtml}
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
  <p style="font-size: 12px; color: #6b7280;">Caso de referencia: #${escapeHtml(data.caseId)}. Este mensaje fue generado automáticamente por el sistema de gestión de siniestros de ClaimMix.</p>
</body>
</html>`;

  const text = `Tu reclamo fue asignado a un especialista\n\n${redactado ?? cuerpo}\n\n---\nCaso de referencia: #${data.caseId}. Este mensaje fue generado automáticamente por el sistema de gestión de siniestros de ClaimMix.`;

  return { subject, html, text, cuerpo };
}
