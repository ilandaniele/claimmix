/**
 * GmailSender — EmailProvider implementation that sends via Gmail API.
 *
 * Builds RFC 2822 raw email strings and sends them via
 * users.messages.send (Gmail API v1). Supports:
 *   - Plain-text only emails
 *   - Multipart/alternative emails (text + HTML)
 *   - Threading via threadId + In-Reply-To / References headers (AC5)
 *   - GMAIL_FROM_ADDRESS env var (IC8)
 *
 * AC5:  send() passes threadId in requestBody so reply lands in the same Gmail thread.
 * AC9:  name === 'gmail' (satisfies EmailProvider.name union).
 * AC10: No credential values are ever logged — only error codes.
 * AC12: Only this file (within gmail/) imports from 'googleapis' indirectly via gmail-client.
 */

import "server-only";
import type { EmailProvider, SendEmailOptions, SendResult } from "../provider";
import { getGmailClient } from "./gmail-client";

// ── RFC 2822 helpers ──────────────────────────────────────────────────────────

/**
 * Encode a raw email string to base64url format as required by the Gmail API.
 * Uses Node 22's native Buffer.toString('base64url').
 */
function encodeBase64Url(raw: string): string {
  return Buffer.from(raw).toString("base64url");
}

/**
 * Build a multipart boundary string.
 */
function makeBoundary(): string {
  return `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Build an RFC 2822 raw email string from SendEmailOptions.
 *
 * When opts.htmlBody is provided, builds a multipart/alternative message.
 * Otherwise builds a plain-text message.
 *
 * opts.headers (Name/Value pairs) are appended as additional RFC 2822 headers.
 */
function buildRawEmail(opts: SendEmailOptions): string {
  const from = opts.from;
  const to = opts.to;
  const subject = opts.subject;

  // ── Extra headers (In-Reply-To, References, etc.) ──────────────────────────
  const extraHeaderLines: string[] = (opts.headers ?? []).map(
    (h) => `${h.Name}: ${h.Value}`
  );

  if (opts.htmlBody) {
    // ── Multipart/alternative (text + html) ──────────────────────────────────
    const boundary = makeBoundary();
    const lines: string[] = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ...extraHeaderLines,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: quoted-printable`,
      ``,
      opts.textBody ?? "",
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset="UTF-8"`,
      `Content-Transfer-Encoding: quoted-printable`,
      ``,
      opts.htmlBody,
      ``,
      `--${boundary}--`,
    ];
    return lines.join("\r\n");
  }

  // ── Plain text ──────────────────────────────────────────────────────────────
  const lines: string[] = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ...extraHeaderLines,
    ``,
    opts.textBody ?? "",
  ];
  return lines.join("\r\n");
}

// ── GmailSender ──────────────────────────────────────────────────────────────

export class GmailSender implements EmailProvider {
  readonly name = "gmail" as const;

  constructor(private readonly refreshToken?: string) {}

  async send(opts: SendEmailOptions): Promise<SendResult> {
    try {
      const gmail = getGmailClient(this.refreshToken);
      const rawEmail = buildRawEmail(opts);
      const encodedMessage = encodeBase64Url(rawEmail);

      const requestBody: { raw: string; threadId?: string } = {
        raw: encodedMessage,
      };

      // AC5: include threadId so the reply lands in the same Gmail thread.
      if (opts.threadId) {
        requestBody.threadId = opts.threadId;
      }

      const response = await gmail.users.messages.send({
        userId: "me",
        requestBody,
      });

      const providerMessageId = response.data.id;
      if (!providerMessageId) {
        // Treat a missing ID as a failure — the API call technically succeeded
        // but returned no identifier, so we cannot track the message.
        console.error("[GmailSender] send returned no message id"); // crew-debug-ok
        return { errorCode: "GMAIL_SEND_FAILED" };
      }

      return { providerMessageId };
    } catch (err) {
      // AC10: log only the error code — never credential values or message bodies.
      const code =
        err instanceof Error ? err.name : typeof err === "string" ? err : "UnknownError";
      console.error("[GmailSender] send error:", code); // crew-debug-ok
      return { errorCode: "GMAIL_SEND_FAILED" };
    }
  }
}
