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
}

/**
 * Escapa un valor para meterlo adentro de HTML.
 *
 * ── Por qué hace falta, y qué se podía hacer sin esto ───────────────────────
 *
 * Todo lo que estas plantillas interpolan viene, directa o indirectamente, de
 * un correo que escribió un desconocido: el nombre del asegurado, el lugar del
 * siniestro, la patente, y hasta el NOMBRE de un campo —el modelo puede
 * inventar una clave, y `humanizeKey` la muestra tal cual—.
 *
 * Un nombre como `Juan <a href="https://evil.tld">Cobrá tu indemnización acá</a>`
 * salía entero adentro de un `<strong>`. Y el destinatario lo elige el mismo
 * atacante: el mail sale a la dirección del `From` del correo entrante, que
 * nadie verifica. O sea que alcanza con escribirle al buzón de ingreso poniendo
 * en el From la casilla de la víctima, y la aseguradora le manda —desde su
 * propio dominio, firmado con su DKIM— el enlace que el atacante eligió.
 *
 * Eso es phishing con la reputación de la aseguradora. En los clientes de
 * correo que todavía ejecutan script además es XSS; en los demás es inyección
 * de HTML, que para este producto es igual de grave.
 *
 * ── Sólo para el HTML ───────────────────────────────────────────────────────
 *
 * La versión `text` de cada plantilla NO se escapa, y no es un olvido: ahí
 * `&amp;` se leería literal. Un correo en texto plano no interpreta marcado, así
 * que no hay nada de qué escaparse.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
 * @returns { subject, html, text }
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
        noted: data.noted != null ? String(data.noted) : null,
      });

    case "confirmation_received":
      return renderConfirmationReceived({
        caseId: String(data.caseId ?? ""),
        claimType: data.claimType != null ? String(data.claimType) : null,
        policyNumber: data.policyNumber != null ? String(data.policyNumber) : null,
              isFollowUp: data.isFollowUp === true,
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
      });

    case "specialist_escalation":
      return renderSpecialistEscalation({
        caseId: String(data.caseId ?? ""),
        severity: data.severity != null ? String(data.severity) : undefined,
      });

    default: {
      const exhaustiveCheck: never = template;
      throw new Error(
        `[render] Unknown email template: ${exhaustiveCheck as string}`
      );
    }
  }
}
