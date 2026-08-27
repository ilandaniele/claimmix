import "server-only";

export type IntakePrefilterDecision =
  | { action: "allow" }
  | { action: "skip"; reason: string; category: "automated_non_claim" | "bulk_non_claim" };

interface IntakePrefilterInput {
  fromAddr: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  headers?: Array<{ name?: string | null; value?: string | null }>;
}

const CLAIM_SIGNAL_TERMS = [
  "accidente",
  "asegurado",
  "choque",
  "claim",
  "colision",
  "denuncia",
  "granizo",
  "hurto",
  "incendio",
  "patente",
  "poliza",
  "reclamo",
  "robo",
  "seguro",
  "siniestro",
];

const AUTOMATED_SENDER_TERMS = [
  "facebookmail.com",
  "instagram",
  "meta",
  "notification",
  "notifications",
  "no-reply",
  "noreply",
  "security",
];

const AUTOMATED_SUBJECT_TERMS = [
  "account alert",
  "business notification",
  "codigo de seguridad",
  "confirm your account",
  "facebook",
  "instagram",
  "meta for business",
  "security code",
  "verify your account",
];

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function visibleHtmlText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function headerValue(
  headers: Array<{ name?: string | null; value?: string | null }>,
  name: string
): string {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name?.toLowerCase() === lower)?.value ?? "";
}

function includesAny(value: string, terms: string[]): boolean {
  return terms.some((term) => value.includes(term));
}

function hasClaimSignal(subject: string, body: string): boolean {
  const combined = normalize(`${subject}\n${body}`);
  return includesAny(combined, CLAIM_SIGNAL_TERMS);
}

function isBulkHeader(headers: Array<{ name?: string | null; value?: string | null }>): boolean {
  const listUnsubscribe = headerValue(headers, "List-Unsubscribe");
  const precedence = headerValue(headers, "Precedence");
  const autoSubmitted = headerValue(headers, "Auto-Submitted");
  return Boolean(
    listUnsubscribe ||
      normalize(precedence).includes("bulk") ||
      normalize(autoSubmitted).includes("auto-")
  );
}

export function classifyInboundEmailForIntake(
  input: IntakePrefilterInput
): IntakePrefilterDecision {
  const headers = input.headers ?? [];
  const body = `${input.bodyText}\n${visibleHtmlText(input.bodyHtml)}`.trim();

  /*
   * `List-Unsubscribe` se mira ANTES que la señal de siniestro, y el orden es
   * todo el arreglo.
   *
   * La señal de siniestro devolvía `allow` de entrada, así que las cabeceras no
   * se consultaban nunca para un mensaje que hablara de seguros. Y un newsletter
   * del rubro habla de seguros por definición: «Novedades del sector asegurador»
   * contiene «asegurado», que está en la lista de más arriba. O sea que los
   * únicos newsletters que este filtro no podía frenar eran exactamente los que
   * recibe la casilla de una aseguradora.
   *
   * Se mueve sólo `List-Unsubscribe`, y no las otras dos cabeceras. Ésa la pone
   * quien manda una lista de correo y nadie más: el cliente de mail de alguien
   * que acaba de chocar no la agrega. `Precedence: bulk` y `Auto-Submitted` se
   * quedan abajo, porque un mail reenviado en automático sí puede traerlas y sí
   * puede ser una denuncia de verdad.
   *
   * La dirección de cautela importa: frenar una denuncia real es mucho peor que
   * gastar seis milésimos de dólar en un newsletter.
   */
  if (headerValue(headers, "List-Unsubscribe")) {
    return {
      action: "skip",
      reason: "mailing_list_unsubscribe_header",
      category: "bulk_non_claim",
    };
  }

  if (hasClaimSignal(input.subject, body)) return { action: "allow" };

  const from = normalize(input.fromAddr);
  const subject = normalize(input.subject);
  const thinBody = body.replace(/\s+/g, " ").trim().length < 40;
  const automatedSender = includesAny(from, AUTOMATED_SENDER_TERMS);
  const automatedSubject = includesAny(subject, AUTOMATED_SUBJECT_TERMS);

  if (automatedSender && (automatedSubject || thinBody)) {
    return {
      action: "skip",
      reason: "automated_sender_without_claim_signal",
      category: "automated_non_claim",
    };
  }

  if (isBulkHeader(headers)) {
    return {
      action: "skip",
      reason: "bulk_email_without_claim_signal",
      category: "bulk_non_claim",
    };
  }

  return { action: "allow" };
}
