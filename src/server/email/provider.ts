/**
 * EmailProvider interface for ClaimMix outbound email.
 *
 * Provider-specific code lives under src/server/email/gmail/.
 * Callers (dispatch.ts, orchestrate.ts) import from here — never from gmail directly.
 *
 * IC8: Interface focuses on the outbound seam (send). Inbound HMAC + Zod parsing
 * are provider-aware but not part of this interface (they run before provider selection).
 *
 * AC9:  EmailProvider.name is 'gmail'.
 * AC12: Confirmation receipt always sent via this interface — no direct provider imports
 * in src/server/confirmations/** or src/server/email/dispatch.ts.
 */

export interface SendEmailOptions {
  to: string;
  from: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  replyTo?: string;
  /** Provider headers array — used for In-Reply-To, References threading. */
  headers?: Array<{ Name: string; Value: string }>;
  tag?: string;
  /**
   * Gmail thread ID — when provided, GmailSender passes this as threadId in
   * users.messages.send so the reply lands in the same Gmail thread (AC5).
   */
  threadId?: string;
}

export type SendResult =
  | { providerMessageId: string }
  | { errorCode: string };

export interface EmailProvider {
  readonly name: "gmail" | "smtp";
  send(opts: SendEmailOptions): Promise<SendResult>;
}

/**
 * Type guard: returns true when the SendResult is a success (has providerMessageId).
 */
export function isSendSuccess(r: SendResult): r is { providerMessageId: string } {
  return "providerMessageId" in r;
}
