/**
 * Email template: data_confirmation_request
 *
 * Sent when a field has medium confidence or conflicts with stored customer data.
 * Shows the extracted value and asks the claimant to confirm or correct it.
 *
 * AC7: Shows proposed value for medium-confidence fields.
 * AC9: Shows conflicting value for conflict cases.
 * AC24: Sensitive values (DNI, policy_number) are masked before display.
 *
 * Subject: "Confirmar datos de reclamo - Caso #{caseId}"
 */

import { displayFieldValue, labelForField } from "@/lib/labels/claim-fields";
import { maskDni, maskPolicyNumber } from "@/server/email/render";

export interface DataConfirmationRequestData {
  caseId: string;
  fieldKey: string;
  proposedValue: string;
  /** If set: the value already on file (conflict scenario). */
  conflictWithValue?: string | null;
}

const SENSITIVE_FIELDS = new Set(["dni", "policy_number"]);

/**
 * Mask a sensitive value, and translate an enum value into Spanish.
 *
 * Returns null when the value is not worth showing: `claim_type: other` is the
 * extractor saying it did not recognize the accident, and there is no phrasing
 * of that a claimant can confirm or correct. Translating it to "siniestro"
 * only hid the problem — the email then asked someone to confirm that the type
 * of their siniestro was "siniestro".
 */
function maskFieldValue(fieldKey: string, value: string): string | null {
  if (fieldKey === "dni") return maskDni(value);
  if (fieldKey === "policy_number") return maskPolicyNumber(value);
  return displayFieldValue(fieldKey, value);
}

export function renderDataConfirmationRequest(
  data: DataConfirmationRequestData
): {
  subject: string;
  html: string;
  text: string;
} {
  const field = labelForField(data.fieldKey);
  const fieldLabel = field.label;
  const isSensitive = SENSITIVE_FIELDS.has(data.fieldKey);
  const displayValue = maskFieldValue(data.fieldKey, data.proposedValue);
  const displayConflict = data.conflictWithValue
    ? maskFieldValue(data.fieldKey, data.conflictWithValue)
    : null;

  // With no value to show, there is nothing to confirm — so ask the question
  // outright instead. An agent that could not work something out asks for it;
  // it does not present a blank and request approval of the blank.
  const isOpenQuestion = !displayValue;

  const subject = isOpenQuestion
    ? `Nos falta un dato de tu reclamo - Caso #${data.caseId}`
    : `Confirmar datos de reclamo - Caso #${data.caseId}`;

  const heading = isOpenQuestion ? "Nos falta un dato" : "Confirmación de datos requerida";

  const introHtml = isOpenQuestion
    ? `<p>Para el <strong>caso #${data.caseId}</strong>, nos falta un dato para poder avanzar:</p>`
    : `<p>Para el <strong>caso #${data.caseId}</strong>, necesitamos que confirmes el siguiente dato:</p>`;
  const introText = isOpenQuestion
    ? `Para el caso #${data.caseId}, nos falta un dato para poder avanzar:`
    : `Para el caso #${data.caseId}, necesitamos que confirmes el siguiente dato:`;

  let contextHtml = "";
  let contextText = "";

  if (isOpenQuestion) {
    contextHtml = `<p>${field.instruction}</p>`;
    contextText = `${field.instruction}\n\n`;
  } else if (displayConflict) {
    contextHtml = `<p>Notamos que el valor que indicaste en tu email (<strong>${displayValue}</strong>) difiere del que tenemos registrado en nuestro sistema (<strong>${displayConflict}</strong>).</p>`;
    contextText = `Notamos que el valor que indicaste en tu email (${displayValue}) difiere del que tenemos registrado en nuestro sistema (${displayConflict}).\n\n`;
  } else {
    contextHtml = `<p>Obtuvimos el siguiente dato de tu correo: <strong>${displayValue}</strong>${isSensitive ? " (valor enmascarado por seguridad)" : ""}.</p>`;
    contextText = `Obtuvimos el siguiente dato de tu correo: ${displayValue}${isSensitive ? " (valor enmascarado por seguridad)" : ""}.\n\n`;
  }

  // "Escribí Confirmo" only makes sense against a value we showed them.
  const actionHtml = isOpenQuestion
    ? `<p>Respondé este correo con el dato y seguimos con tu reclamo.</p>`
    : `<p>Por favor respondé este correo con una de las siguientes opciones:</p>
  <ul>
    <li>Escribí <strong>"Confirmo"</strong> si el dato es correcto.</li>
    <li>O bien, escribí el valor correcto directamente en tu respuesta.</li>
  </ul>`;
  const actionText = isOpenQuestion
    ? `Respondé este correo con el dato y seguimos con tu reclamo.`
    : `Por favor respondé este correo con una de las siguientes opciones:\n- Escribí "Confirmo" si el dato es correcto.\n- O bien, escribí el valor correcto directamente en tu respuesta.`;

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>${subject}</title></head>
<body style="font-family: Arial, sans-serif; color: #222; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 20px; color: #1a56db;">${heading}</h1>
  ${introHtml}
  <p><strong>Campo:</strong> ${fieldLabel}</p>
  ${contextHtml}
  ${actionHtml}
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
  <p style="font-size: 12px; color: #6b7280;">Caso de referencia: #${data.caseId}. Este mensaje fue generado automáticamente.</p>
</body>
</html>`;

  const text = `${heading}\n\n${introText}\n\nCampo: ${fieldLabel}\n${contextText}${actionText}\n\n---\nCaso de referencia: #${data.caseId}. Este mensaje fue generado automáticamente.`;

  return { subject, html, text };
}
