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
 * Both matter here. A claimant was asked to confirm that the type of their
 * claim was "other" — the raw enum member, which means nothing to them and
 * cannot be confirmed or corrected because it is not a thing that happened.
 */
function maskFieldValue(fieldKey: string, value: string): string {
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
  const subject = `Confirmar datos de reclamo - Caso #${data.caseId}`;
  const fieldLabel = labelForField(data.fieldKey).label;
  const isSensitive = SENSITIVE_FIELDS.has(data.fieldKey);
  const displayValue = maskFieldValue(data.fieldKey, data.proposedValue);

  let contextHtml = "";
  let contextText = "";

  if (data.conflictWithValue) {
    const displayConflict = maskFieldValue(data.fieldKey, data.conflictWithValue);
    contextHtml = `<p>Notamos que el valor que indicaste en tu email (<strong>${displayValue}</strong>) difiere del que tenemos registrado en nuestro sistema (<strong>${displayConflict}</strong>).</p>`;
    contextText = `Notamos que el valor que indicaste en tu email (${displayValue}) difiere del que tenemos registrado en nuestro sistema (${displayConflict}).\n\n`;
  } else {
    contextHtml = `<p>Obtuvimos el siguiente dato de tu correo: <strong>${displayValue}</strong>${isSensitive ? " (valor enmascarado por seguridad)" : ""}.</p>`;
    contextText = `Obtuvimos el siguiente dato de tu correo: ${displayValue}${isSensitive ? " (valor enmascarado por seguridad)" : ""}.\n\n`;
  }

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>${subject}</title></head>
<body style="font-family: Arial, sans-serif; color: #222; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 20px; color: #1a56db;">Confirmación de datos requerida</h1>
  <p>Para el <strong>caso #${data.caseId}</strong>, necesitamos que confirmes el siguiente dato:</p>
  <p><strong>Campo:</strong> ${fieldLabel}</p>
  ${contextHtml}
  <p>Por favor respondé este correo con una de las siguientes opciones:</p>
  <ul>
    <li>Escribí <strong>"Confirmo"</strong> si el dato es correcto.</li>
    <li>O bien, escribí el valor correcto directamente en tu respuesta.</li>
  </ul>
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
  <p style="font-size: 12px; color: #6b7280;">Caso de referencia: #${data.caseId}. Este mensaje fue generado automáticamente.</p>
</body>
</html>`;

  const text = `Confirmación de datos requerida\n\nPara el caso #${data.caseId}, necesitamos que confirmes el siguiente dato:\n\nCampo: ${fieldLabel}\n${contextText}Por favor respondé este correo con una de las siguientes opciones:\n- Escribí "Confirmo" si el dato es correcto.\n- O bien, escribí el valor correcto directamente en tu respuesta.\n\n---\nCaso de referencia: #${data.caseId}. Este mensaje fue generado automáticamente.`;

  return { subject, html, text };
}
