/**
 * Email template renderer for ClaimMix outbound emails.
 *
 * All templates are rendered server-side to plain HTML + text.
 * PII masking is MANDATORY per AC24 — DNI and full policy_number must
 * never appear verbatim in outbound email bodies.
 *
 * Usage:
 *   const { subject, html, text } = renderTemplate('confirmation_received', { caseId: '...' });
 *
 * Template keys correspond to outbound email template names (also stored in
 * outbound_messages.template for audit purposes).
 */

import { renderConfirmationReceived } from "./templates/confirmation-received";
import { renderMissingInformationRequest } from "./templates/missing-information-request";
import { renderDataConfirmationRequest } from "./templates/data-confirmation-request";
import { renderSpecialistEscalation } from "./templates/specialist-escalation";
import { renderInformationReceived } from "./templates/information-received";

/**
 * Se re-exporta desde acá porque es de donde lo importan las cinco plantillas.
 * Vive en el núcleo desde que hay dos entradas para escapar y no una: los datos
 * de la plantilla, y la prosa que devuelve el redactor.
 */
export { escapeHtml } from "@/core/email/html";

/** All supported outbound email template keys. */
export type EmailTemplate =
  | "confirmation_received"
  | "missing_information_request"
  | "data_confirmation_request"
  | "specialist_escalation"
  // Acusar recibo sin repetir el pedido: la persona contó algo nuevo y lo
  // que falta sigue siendo lo mismo que ya le pedimos.
  | "information_received";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /**
   * La prosa, sin el cromo.
   *
   * Es lo que va entre el título y la línea de corte: ni el DOCTYPE, ni el
   * encabezado, ni el pie, ni el «Caso de referencia». El mensajero se la
   * entrega al redactor como piso —«decí esto mejor»— y le devuelve la versión
   * redactada por `data.cuerpo`, que es lo único que la plantilla reemplaza.
   *
   * Pasarle el documento entero haría que el modelo reescriba el pie, queme los
   * 1400 caracteres en cromo y coseche rechazos por largo sin motivo real.
   */
  cuerpo: string;
}

// ── PII masking (AC24) ────────────────────────────────────────────────────────

/**
 * Mask a DNI — show only the last 4 digits.
 * Input: "20345678" | "20.345.678"
 * Output: "****5678"
 *
 * Handles both dotted (e.g. "20.345.678") and plain (e.g. "20345678") formats.
 * Always returns last 4 alphanumeric digits of the stripped DNI.
 */
export function maskDni(dni: string): string {
  const stripped = dni.replace(/\D/g, ""); // keep only digits
  if (stripped.length < 4) return "****";
  return "****" + stripped.slice(-4);
}

/**
 * Mask a policy number — show only the last 4 characters of the numeric suffix.
 * Input: "POL-12345678" → "POL-****5678"
 * Input: "12345678"     → "****5678"
 * Input: "POL-1234"     → "POL-****1234"
 *
 * Preserves any non-digit prefix (e.g. "POL-") to maintain recognizability.
 */
export function maskPolicyNumber(policyNumber: string): string {
  // Split into prefix (non-digits) and suffix (digits at the end).
  const match = policyNumber.match(/^(.*?)(\d{4,})$/);
  if (!match) {
    // If it's entirely non-numeric or < 4 digits, mask all.
    return "****";
  }
  const [, prefix, digits] = match;
  const maskedDigits = "****" + digits.slice(-4);
  return prefix + maskedDigits;
}

// ── Template dispatcher ───────────────────────────────────────────────────────

/**
 * Render an outbound email template.
 *
 * @param template - Template key
 * @param data     - Template data (varies per template — validated at call site)
 * @returns { subject, html, text, cuerpo }
 *
 * `data.cuerpo` es la prosa ya redactada. Cuando viene, reemplaza la prosa de
 * la plantilla y NADA más: el asunto, el encabezado, el número de caso, el pie
 * y el enmascarado siguen siendo los de siempre. Cuando no viene —el redactor
 * apagado, una guarda que rebotó— la salida es byte a byte la de antes, y por
 * eso el mensajero no pasa el argumento en vez de pasar el piso otra vez.
 * @throws  Error if an unknown template key is provided
 */
export function renderTemplate(
  template: EmailTemplate,
  data: Record<string, unknown>
): RenderedEmail {
  switch (template) {
    case "information_received":
      return renderInformationReceived({
        caseId: String(data.caseId ?? ""),
        /*
         * El que el orquestador manda y este `case` descartaba.
         *
         * Con los dos canales pasando por el redactor el modelo lo recibe igual
         * desde `message.data`, pero el PISO es lo que sale con el interruptor
         * en off y cuando rebota una guarda: dejarlo así era arreglar el techo
         * y no el piso.
         *
         * (Acá vivía `noted`, que nadie seteaba nunca — ni por mail ni por
         * WhatsApp— y estaba declarado en los dos escritores. Un parámetro
         * muerto en dos lados es exactamente cómo el próximo lo «pasa» y no
         * cambia nada. `isFollowUp` no se agrega por lo mismo: esta plantilla
         * sólo sale en una vuelta posterior, así que no tendría qué decidir.)
         */
        claimantName: data.claimantName != null ? String(data.claimantName) : null,
        cuerpo: data.cuerpo != null ? String(data.cuerpo) : null,
      });

    case "confirmation_received":
      return renderConfirmationReceived({
        caseId: String(data.caseId ?? ""),
        claimType: data.claimType != null ? String(data.claimType) : null,
        policyNumber: data.policyNumber != null ? String(data.policyNumber) : null,
        isFollowUp: data.isFollowUp === true,
        claimantName: data.claimantName != null ? String(data.claimantName) : null,
        cuerpo: data.cuerpo != null ? String(data.cuerpo) : null,
      });

    case "missing_information_request":
      return renderMissingInformationRequest({
        caseId: String(data.caseId ?? ""),
        missingFields: Array.isArray(data.missingFields)
          ? (data.missingFields as string[]).map(String)
          : [],
        knownValues:
          data.knownValues && typeof data.knownValues === "object"
            ? (data.knownValues as Record<string, string>)
            : undefined,
        /*
         * Los tres que el orquestador ya mandaba y este `case` no pasaba.
         *
         * `question` es el que más pesa: la persona escribía «¿cuánto tarda
         * esto? lo necesito para trabajar» y recibía la misma lista de datos
         * faltantes que la vuelta anterior, palabra por palabra, sin una línea
         * sobre lo que preguntó. La pregunta llegaba hasta acá y se caía en el
         * borde entre `data` y el armador.
         */
        question: data.question != null ? String(data.question) : null,
        isFollowUp: data.isFollowUp === true,
        claimantName: data.claimantName != null ? String(data.claimantName) : null,
        cuerpo: data.cuerpo != null ? String(data.cuerpo) : null,
      });

    case "data_confirmation_request":
      return renderDataConfirmationRequest({
        caseId: String(data.caseId ?? ""),
        fieldKey: String(data.fieldKey ?? ""),
        proposedValue: String(data.proposedValue ?? ""),
        conflictWithValue:
          data.conflictWithValue != null ? String(data.conflictWithValue) : null,
        // Varios datos en un mensaje. Si no viene, la plantilla usa el campo
        // suelto de arriba, que es el caso de uno solo.
        fields: Array.isArray(data.fields)
          ? (data.fields as Array<Record<string, unknown>>).map((c) => ({
              fieldKey: String(c.fieldKey ?? ""),
              proposedValue: String(c.proposedValue ?? ""),
              conflictWithValue:
                c.conflictWithValue != null ? String(c.conflictWithValue) : null,
            }))
          : undefined,
        cuerpo: data.cuerpo != null ? String(data.cuerpo) : null,
      });

    case "specialist_escalation":
      return renderSpecialistEscalation({
        caseId: String(data.caseId ?? ""),
        severity: data.severity != null ? String(data.severity) : undefined,
        cuerpo: data.cuerpo != null ? String(data.cuerpo) : null,
      });

    default: {
      const exhaustiveCheck: never = template;
      throw new Error(
        `[render] Unknown email template: ${exhaustiveCheck as string}`
      );
    }
  }
}
