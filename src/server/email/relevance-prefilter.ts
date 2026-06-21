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
