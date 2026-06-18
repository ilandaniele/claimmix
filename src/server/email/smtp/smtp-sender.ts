import "server-only";
import nodemailer from "nodemailer";
import type { EmailProvider, SendEmailOptions, SendResult } from "../provider";

export class SmtpSender implements EmailProvider {
  readonly name = "smtp" as const;

  private transporter: nodemailer.Transporter;

  constructor() {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT ?? "587", 10);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!host || !user || !pass) {
      throw new Error("SMTP_HOST, SMTP_USER, and SMTP_PASS must be set for outbound email");
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
  }

  async send(opts: SendEmailOptions): Promise<SendResult> {
    try {
      const extraHeaders: Record<string, string> = {};
      for (const h of opts.headers ?? []) {
        extraHeaders[h.Name] = h.Value;
      }

      const info = await this.transporter.sendMail({
        from: opts.from,
        to: opts.to,
        replyTo: opts.replyTo ?? opts.from,
        subject: opts.subject,
        text: opts.textBody,
        html: opts.htmlBody,
        headers: extraHeaders,
      });

      return { providerMessageId: info.messageId };
    } catch (err) {
      const code = err instanceof Error ? err.message.slice(0, 80) : "SMTP_ERROR";
      return { errorCode: code };
    }
  }
}
