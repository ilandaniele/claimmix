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

export interface MissingInformationRequestData {
  caseId: string;
  missingFields: string[];
}

/** Human-readable label and instruction per field key (es-AR). */
const FIELD_INSTRUCTIONS: Record<string, { label: string; instruction: string }> = {
  policy_number: {
    label: "Número de póliza",
    instruction: "Indicá el número de póliza de tu seguro (ej: POL-12345).",
  },
  accident_date: {
    label: "Fecha del siniestro",
    instruction: "Indicá la fecha en que ocurrió el siniestro (ej: 15/05/2024).",
  },
  accident_location: {
    label: "Lugar del siniestro",
    instruction: "Indicá la dirección o localidad donde ocurrió el siniestro.",
  },
  accident_description: {
    label: "Descripción del siniestro",
    instruction: "Describí brevemente qué ocurrió durante el siniestro.",
  },
  dni: {
    label: "DNI del titular",
    instruction: "Indicá el número de DNI del titular de la póliza.",
  },
  full_name: {
    label: "Nombre completo",
    instruction: "Indicá tu nombre y apellido completo.",
  },
  phone: {
    label: "Teléfono de contacto",
    instruction: "Indicá un número de teléfono donde podamos contactarte.",
  },
  claim_type: {
    label: "Tipo de siniestro",
    instruction:
      "Indicá el tipo de siniestro (choque, robo, granizo, incendio, etc.).",
  },
};

function getFieldInstruction(fieldKey: string): { label: string; instruction: string } {
  return (
    FIELD_INSTRUCTIONS[fieldKey] ?? {
      label: fieldKey,
      instruction: `Proporcioná el valor para el campo: ${fieldKey}.`,
    }
  );
}

export function renderMissingInformationRequest(
  data: MissingInformationRequestData
): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Información adicional requerida - Caso #${data.caseId}`;

  const fieldItemsHtml = data.missingFields
    .map((fieldKey) => {
      const { label, instruction } = getFieldInstruction(fieldKey);
      return `<li><strong>${label}:</strong> ${instruction}</li>`;
    })
    .join("\n");

  const fieldItemsText = data.missingFields
    .map((fieldKey) => {
      const { label, instruction } = getFieldInstruction(fieldKey);
      return `- ${label}: ${instruction}`;
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
