/**
 * Plantilla de correo: data_confirmation_request
 *
 * Sale cuando un dato tiene confianza media o no coincide con lo que figura del
 * cliente. Muestra lo que se leyó y pide que lo confirmen o lo corrijan.
 *
 * AC7: muestra el valor propuesto para los datos de confianza media.
 * AC9: muestra el valor en conflicto cuando no coincide con el padrón.
 * AC24: los valores sensibles (DNI, número de póliza) se enmascaran.
 *
 * ── Por qué acepta una lista y no un dato ───────────────────────────────────
 *
 * Cuando el asegurado tenía tres datos que no coincidían —lo que pasa cuando
 * escribe un familiar del titular, con su propio nombre, su mail y su DNI— la
 * rama D del orquestador mandaba TRES correos casi idénticos. Cada uno pedía un
 * dato y los tres decían lo mismo alrededor.
 *
 * Ahora recibe los campos juntos y arma un mensaje. Los campos sueltos siguen
 * funcionando: son el caso de uno solo.
 */

import { displayFieldValue, labelForField } from "@/lib/labels/claim-fields";
import { escapeHtml, maskDni, maskPolicyNumber } from "@/server/email/render";

/** Un dato sobre el que se pregunta. */
export interface CampoAConfirmar {
  fieldKey: string;
  proposedValue: string;
  /** Si viene: el valor que ya figuraba en el padrón (caso de conflicto). */
  conflictWithValue?: string | null;
}

export interface DataConfirmationRequestData extends CampoAConfirmar {
  caseId: string;
  /** Varios datos en un solo mensaje. Si falta, se usa el campo suelto. */
  fields?: CampoAConfirmar[];
}

const SENSITIVE_FIELDS = new Set(["dni", "policy_number"]);

/**
 * Enmascara un valor sensible, y traduce un valor de enumeración al castellano.
 *
 * Devuelve null cuando el valor no vale la pena mostrarlo: `claim_type: other`
 * es el extractor diciendo que no reconoció el siniestro, y no hay forma de
 * escribir eso que una persona pueda confirmar o corregir. Traducirlo a
 * "siniestro" sólo tapaba el problema — el correo terminaba pidiéndole a
 * alguien que confirmara que el tipo de su siniestro era "siniestro".
 */
function maskFieldValue(fieldKey: string, value: string): string | null {
  if (fieldKey === "dni") return maskDni(value);
  if (fieldKey === "policy_number") return maskPolicyNumber(value);
  return displayFieldValue(fieldKey, value);
}

interface BloqueDeCampo {
  /** Sin valor que mostrar: en vez de pedir que confirmen un blanco, se pregunta. */
  abierto: boolean;
  html: string;
  text: string;
}

function armarBloque(campo: CampoAConfirmar): BloqueDeCampo {
  const field = labelForField(campo.fieldKey);
  const displayValue = maskFieldValue(campo.fieldKey, campo.proposedValue);
  const displayConflict = campo.conflictWithValue
    ? maskFieldValue(campo.fieldKey, campo.conflictWithValue)
    : null;

  const abierto = !displayValue;
  const sensible = SENSITIVE_FIELDS.has(campo.fieldKey);

  let contextoHtml: string;
  let contextoText: string;

  /*
   * Todo lo que se mete en el HTML se escapa: viene de un correo que escribió
   * un desconocido. Hasta la ETIQUETA del campo, porque el modelo puede
   * inventar una clave y `humanizeKey` la muestra tal cual.
   *
   * Las versiones `text` van sin escapar a propósito: un correo en texto plano
   * no interpreta marcado, y ahí `&amp;` se leería literal.
   */
  if (abierto) {
    contextoHtml = `<p>${escapeHtml(field.instruction)}</p>`;
    contextoText = field.instruction;
  } else if (displayConflict) {
    contextoHtml = `<p>Notamos que el valor que indicaste en tu email (<strong>${escapeHtml(displayValue)}</strong>) difiere del que tenemos registrado en nuestro sistema (<strong>${escapeHtml(displayConflict)}</strong>).</p>`;
    contextoText = `Notamos que el valor que indicaste en tu email (${displayValue}) difiere del que tenemos registrado en nuestro sistema (${displayConflict}).`;
  } else {
    const nota = sensible ? " (valor enmascarado por seguridad)" : "";
    contextoHtml = `<p>Obtuvimos el siguiente dato de tu correo: <strong>${escapeHtml(displayValue)}</strong>${nota}.</p>`;
    contextoText = `Obtuvimos el siguiente dato de tu correo: ${displayValue}${nota}.`;
  }

  return {
    abierto,
    html: `<p><strong>Campo:</strong> ${escapeHtml(field.label)}</p>
  ${contextoHtml}`,
    text: [`Campo: ${field.label}`, contextoText].join("\n"),
  };
}

export function renderDataConfirmationRequest(
  data: DataConfirmationRequestData
): {
  subject: string;
  html: string;
  text: string;
} {
  const campos: CampoAConfirmar[] =
    data.fields && data.fields.length > 0
      ? data.fields
      : [
          {
            fieldKey: data.fieldKey,
            proposedValue: data.proposedValue,
            conflictWithValue: data.conflictWithValue,
          },
        ];

  const bloques = campos.map(armarBloque);

  /*
   * Con que UNO traiga valor, hay algo que confirmar.
   *
   * Si todos son preguntas abiertas el mensaje entero es un pedido de datos, y
   * el «Escribí Confirmo» de abajo no tendría contra qué. Mezclados, gana pedir
   * confirmación: el que no tiene valor igual se pregunta en su bloque.
   */
  const isOpenQuestion = bloques.every((b) => b.abierto);
  const varios = bloques.length > 1;

  const subject = isOpenQuestion
    ? `${varios ? "Nos faltan datos" : "Nos falta un dato"} de tu reclamo - Caso #${data.caseId}`
    : `Confirmar datos de reclamo - Caso #${data.caseId}`;

  const heading = isOpenQuestion
    ? varios
      ? "Nos faltan algunos datos"
      : "Nos falta un dato"
    : "Confirmación de datos requerida";

  // Abre acusando recibo: es el único correo que le llega al asegurado cuando
  // hay algo dudoso, así que tiene que hacer el trabajo que hacía el
  // `confirmation_received` separado.
  const queSigue = isOpenQuestion
    ? varios
      ? "nos faltan algunos datos para poder avanzar:"
      : "nos falta un dato para poder avanzar:"
    : varios
      ? "necesitamos que confirmes los siguientes datos:"
      : "necesitamos que confirmes el siguiente dato:";

  const introHtml = `<p>Gracias por tu reclamo. Lo registramos como <strong>caso #${escapeHtml(data.caseId)}</strong>, y ${queSigue}</p>`;
  const introText = `Gracias por tu reclamo. Lo registramos como caso #${data.caseId}, y ${queSigue}`;

  const actionHtml = isOpenQuestion
    ? `<p>Respondé este correo con ${varios ? "los datos" : "el dato"} y seguimos con tu reclamo.</p>`
    : `<p>Por favor respondé este correo con una de las siguientes opciones:</p>
  <ul>
    <li>Escribí <strong>"Confirmo"</strong> si ${varios ? "los datos son correctos" : "el dato es correcto"}.</li>
    <li>O bien, escribí ${varios ? "los valores correctos" : "el valor correcto"} directamente en tu respuesta.</li>
  </ul>`;

  const actionText = isOpenQuestion
    ? `Respondé este correo con ${varios ? "los datos" : "el dato"} y seguimos con tu reclamo.`
    : [
        "Por favor respondé este correo con una de las siguientes opciones:",
        `- Escribí "Confirmo" si ${varios ? "los datos son correctos" : "el dato es correcto"}.`,
        `- O bien, escribí ${varios ? "los valores correctos" : "el valor correcto"} directamente en tu respuesta.`,
      ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family: Arial, sans-serif; color: #222; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 20px; color: #1a56db;">${escapeHtml(heading)}</h1>
  ${introHtml}
  ${bloques.map((b) => b.html).join("\n  ")}
  ${actionHtml}
  <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
  <p style="font-size: 12px; color: #6b7280;">Caso de referencia: #${escapeHtml(data.caseId)}. Este mensaje fue generado automáticamente.</p>
</body>
</html>`;

  const text = [
    heading,
    "",
    introText,
    "",
    bloques.map((b) => b.text).join("\n\n"),
    "",
    actionText,
    "",
    "---",
    `Caso de referencia: #${data.caseId}. Este mensaje fue generado automáticamente.`,
  ].join("\n");

  return { subject, html, text };
}
