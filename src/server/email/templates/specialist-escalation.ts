
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
  /** El titular del padrón, en iniciales: «R*** P***». Nunca el nombre entero. */
  titularIniciales?: string | null;
  /** El nombre que dio quien escribe, tal cual lo escribió. */
  claimantName?: string | null;
  /** La prosa ya redactada. Reemplaza el cuerpo y nada más. */
  cuerpo?: string | null;
}

/**
 * Los dos valores que no coinciden, dichos.
 *
 * Es el único párrafo de este mensaje cuyo piso es un dato y no una frase.
 * Quien escribe por la póliza de otro —un familiar del titular— recibe que su
 * caso pasó a una persona y no tiene con qué contestar: no sabe cuál de los
 * dos nombres estamos mirando. Nombrarlos es AC7/AC9.
 *
 * Sale sólo cuando están los dos. Un escalado por severidad no tiene por qué
 * mencionar ningún padrón, y el del padrón sin el que dijo la persona es una
 * acusación sin término de comparación.
 *
 * Va DESPUÉS de la prosa y FUERA de `cuerpo`, que es lo único que el redactor
 * ve y reescribe: la mitad que es un dato no puede depender de que el modelo
 * se acuerde de copiarla. Por eso tampoco se repite cuando el redactor
 * contesta — nunca la tuvo.
 */
function laDiferencia(data: SpecialistEscalationData): string | null {
  const padron = data.titularIniciales?.trim();
  const dijo = data.claimantName?.trim();
  if (!padron || !dijo) return null;

  return (
    `La póliza figura a nombre de ${padron} y vos nos decís que sos ${dijo}. ` +
    `El especialista va a revisar esa diferencia; si querés, contanos qué relación tenés con el titular.`
  );
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
  const diferencia = laDiferencia(data);

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
  ${diferencia ? `<p>${escapeHtml(diferencia)}</p>` : ""}
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
  <p style="font-size: 12px; color: #6b7280;">Caso de referencia: #${escapeHtml(data.caseId)}. Este mensaje fue generado automáticamente por el sistema de gestión de siniestros de ClaimMix.</p>
</body>
</html>`;

  const text = `Tu reclamo fue asignado a un especialista\n\n${redactado ?? cuerpo}${diferencia ? `\n\n${diferencia}` : ""}\n\n---\nCaso de referencia: #${data.caseId}. Este mensaje fue generado automáticamente por el sistema de gestión de siniestros de ClaimMix.`;

  return { subject, html, text, cuerpo };
}
