/**
 * Email template: missing_information_request
 *
 * Sent when required fields are missing after extraction.
 * Lists ONLY the specific missing fields — not the full required list.
 *
 * AC10: Template lists only missing fields with clear per-field instructions.
 * AC24: No DNI or full policy_number in body.
 *
 * Subject: "Información adicional requerida - Caso #{caseId}"
 */

import { displayFieldValue, labelForField } from "@/lib/labels/claim-fields";

export interface MissingInformationRequestData {
  caseId: string;
  missingFields: string[];
  /**
   * Values we already hold for some of the listed fields, keyed by field.
   *
   * An item we have a value for is not a gap, it is a doubt: asking "decinos
   * qué día ocurrió" when they wrote "anteayer" reads as though nobody looked.
   * Those render as what we understood, asking only for a correction.
   */
  knownValues?: Record<string, string>;
}

/**
 * Labels come from the shared table so email and WhatsApp name the same gap the
 * same way. The old local copy stopped at eight canonical keys and fell through
 * to "Proporcioná el valor para el campo: dni_asegurado" for everything the
 * extractor invented, which is most of them.
 */
function getFieldInstruction(fieldKey: string): { label: string; instruction: string } {
  const { label, instruction } = labelForField(fieldKey);
  return { label, instruction };
}

export function renderMissingInformationRequest(
  data: MissingInformationRequestData
): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Información adicional requerida - Caso #${data.caseId}`;

  const known = data.knownValues ?? {};

  /** What to say about one item: a gap to fill, or a value to check. */
  function askFor(fieldKey: string): { label: string; ask: string } {
    const { label, instruction } = getFieldInstruction(fieldKey);
    // Through the same translator the other templates use. Passing the raw
    // value straight through put `entendimos "other"` in a claimant's inbox —
    // the enum member we had already chased out of two other emails, walking
    // back in through the door this list opened. A value with no readable form
    // is not shown at all; the field is simply asked for.
    const raw = known[fieldKey]?.trim();
    const value = raw ? displayFieldValue(fieldKey, raw)?.trim() : undefined;
    return {
      label,
      ask: value
        ? `entendimos ${JSON.stringify(value)}. Si no es así, escribinos el dato correcto.`
        : instruction,
    };
  }

  const fieldItemsHtml = data.missingFields
    .map((fieldKey) => {
      const { label, ask } = askFor(fieldKey);
      return `<li><strong>${label}:</strong> ${ask}</li>`;
    })
    .join("\n");

  const fieldItemsText = data.missingFields
    .map((fieldKey) => {
      const { label, ask } = askFor(fieldKey);
      return `- ${label}: ${ask}`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>${subject}</title></head>
<body style="font-family: Arial, sans-serif; color: #222; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 20px; color: #1a56db;">Información adicional requerida</h1>
  <p>Gracias por tu reclamo. Para poder continuar con el procesamiento del <strong>caso #${data.caseId}</strong>, necesitamos que nos proporciones la siguiente información:</p>
  <ul style="line-height: 1.8;">
    ${fieldItemsHtml}
  </ul>
  <p>Por favor respondé este correo con los datos solicitados. Una vez que los recibamos, continuaremos con el análisis de tu reclamo.</p>
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
  <p style="font-size: 12px; color: #6b7280;">Caso de referencia: #${data.caseId}. Este mensaje fue generado automáticamente.</p>
</body>
</html>`;

  const text = `Información adicional requerida\n\nGracias por tu reclamo. Para poder continuar con el procesamiento del caso #${data.caseId}, necesitamos que nos proporciones la siguiente información:\n\n${fieldItemsText}\n\nPor favor respondé este correo con los datos solicitados. Una vez que los recibamos, continuaremos con el análisis de tu reclamo.\n\n---\nCaso de referencia: #${data.caseId}. Este mensaje fue generado automáticamente.`;

  return { subject, html, text };
}
