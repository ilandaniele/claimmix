/**
 * EmailProvider interface for ClaimMix outbound email.
 *
 * All provider-specific code lives under src/server/email/postmark/.
 * Callers (dispatch.ts, orchestrate.ts) import from here — never from postmark directly.
 *
 * IC8: Interface focuses on the outbound seam (send). Inbound HMAC + Zod parsing
 * are provider-aware but not part of this interface (they run before provider selection).
 *
 * AC12: Confirmation receipt always sent via this interface — no direct Postmark imports
 * in src/server/confirmations/** or src/server/email/dispatch.ts.
 */

export interface SendEmailOptions {
  to: string;
  from: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  replyTo?: string;
  /** Postmark Headers array — used for In-Reply-To, References threading. */
  headers?: Array<{ Name: string; Value: string }>;
  tag?: string;
}

export type SendResult =
  | { providerMessageId: string }
  | { errorCode: string };

export interface EmailProvider {
  readonly name: "postmark";
  send(opts: SendEmailOptions): Promise<SendResult>;
}

/**
 * Type guard: returns true when the SendResult is a success (has providerMessageId).
 */
export function isSendSuccess(r: SendResult): r is { providerMessageId: string } {
  return "providerMessageId" in r;
}
