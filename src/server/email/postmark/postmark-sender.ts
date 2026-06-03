/**
 * Postmark outbound email sender for ClaimMix.
 *
 * Uses the official postmark npm package (v4.x) via ServerClient.
 * Implements the EmailProvider interface — callers never import this directly;
 * they use getEmailProvider() from ./index.ts.
 *
 * Lazy-init pattern: POSTMARK_SERVER_TOKEN and POSTMARK_FROM_ADDRESS are read
 * at send time, not at module import. Missing env vars throw at send time only.
 *
 * Error handling:
 *   - Postmark API errors return { errorCode: 'POSTMARK_SEND_FAILED' }.
 *   - Error code is logged (never the message body — may contain PII).
 *   - Configuration errors (missing token/from) throw so the caller can log
 *     them as OUTBOUND_EMAIL_FAILED via dispatch.ts.
 *
 * AC12: Wraps sendEmail without throwing on Postmark failure.
 * AC13: Reads POSTMARK_SERVER_TOKEN / POSTMARK_FROM_ADDRESS (no Resend vars).
 * AC16: Forwards In-Reply-To and References headers to Postmark's Headers array.
 */

import "server-only";
import { ServerClient } from "postmark";
import type { EmailProvider, SendEmailOptions, SendResult } from "../provider";

export class PostmarkSender implements EmailProvider {
  readonly name = "postmark" as const;

  private _client: ServerClient | null = null;
  private _fromAddress: string | null = null;

  /** Lazy-init: throws at send time if env vars are missing. */
  private getClient(): ServerClient {
    if (this._client) return this._client;

    const token = process.env.POSTMARK_SERVER_TOKEN;
    if (!token) {
      throw new Error(
        "[postmark-sender] POSTMARK_SERVER_TOKEN is not set. Configure this env var."
      );
    }

    this._client = new ServerClient(token);
    return this._client;
  }

  private getFromAddress(): string {
    if (this._fromAddress) return this._fromAddress;

    const from = process.env.POSTMARK_FROM_ADDRESS;
    if (!from) {
      throw new Error(
        "[postmark-sender] POSTMARK_FROM_ADDRESS is not set. Configure this env var."
      );
    }

    this._fromAddress = from;
    return this._fromAddress;
  }

  /**
   * Send an outbound email via Postmark.
   *
   * Returns { providerMessageId } on success, { errorCode } on failure.
   * Never throws — configuration errors are caught and returned as errorCode.
   *
   * AC16: If opts.headers contains In-Reply-To or References, they are forwarded
   * verbatim to Postmark's Headers array.
   */
  async send(opts: SendEmailOptions): Promise<SendResult> {
    let client: ServerClient;
    let from: string;

    try {
      client = this.getClient();
      from = opts.from || this.getFromAddress();
    } catch (configErr) {
      const name = configErr instanceof Error ? configErr.name : "ConfigError";
      console.error("[postmark-sender] Configuration error:", name);
      return { errorCode: "POSTMARK_SEND_FAILED" };
    }

    try {
      const result = await client.sendEmail({
        From: from,
        To: opts.to,
        Subject: opts.subject,
        TextBody: opts.textBody,
        HtmlBody: opts.htmlBody,
        ReplyTo: opts.replyTo,
        Headers: opts.headers,
        Tag: opts.tag,
      });

      return { providerMessageId: result.MessageID };
    } catch (err) {
      // Log the error code/name only — never the message body (may contain PII).
      const name = err instanceof Error ? err.name : "UnknownError";
      const code =
        err != null &&
        typeof err === "object" &&
        "ErrorCode" in err &&
        typeof (err as { ErrorCode: unknown }).ErrorCode === "number"
          ? String((err as { ErrorCode: number }).ErrorCode)
          : name;

      console.error("[postmark-sender] Postmark API error code:", code);
      return { errorCode: "POSTMARK_SEND_FAILED" };
    }
  }
}
