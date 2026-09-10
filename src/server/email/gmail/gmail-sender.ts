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
 * RFC 2047 encoded-word for a header value that is not pure ASCII.
 *
 * Header bytes are ASCII by definition; a raw "ó" in the Subject line ships
 * UTF-8 bytes that the receiving client reads as latin-1, which is how
 * "Información adicional requerida" arrived in a real inbox as
 * "InformaciÃƒÂ³n adicional requerida". Bodies were never affected — they
 * declare charset="UTF-8" — so this stayed hidden until the first subject with
 * an accent in it.
 */
function encodeHeaderValue(value: string): string {
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Base64 body part, wrapped at 76 characters per RFC 2045.
 *
 * The parts used to declare `quoted-printable` while carrying raw UTF-8, which
 * is a lie the receiver is entitled to act on: any literal "=" in the body —
 * a query string, say — is a QP escape sequence to a strict parser.
 */
function encodeBody(value: string): string {
  return (Buffer.from(value, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
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
      `Subject: ${encodeHeaderValue(subject)}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ...extraHeaderLines,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      encodeBody(opts.textBody ?? ""),
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      encodeBody(opts.htmlBody),
      ``,
      `--${boundary}--`,
    ];
    return lines.join("\r\n");
  }

  // ── Plain text ──────────────────────────────────────────────────────────────
  const lines: string[] = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    ...extraHeaderLines,
    ``,
    encodeBody(opts.textBody ?? ""),
  ];
  return lines.join("\r\n");
}

// ── GmailSender ──────────────────────────────────────────────────────────────

/**
 * Read back the RFC Message-ID Gmail assigned to a message we just sent.
 *
 * The send call returns only Gmail's internal id. A claimant's reply carries
 * `In-Reply-To: <...@mail.gmail.com>` — the RFC id — so storing the internal
 * one meant thread matching compared two identifiers that can never be equal,
 * and every reply to a case opened a brand new case.
 *
 * Setting our own Message-ID in the outgoing MIME would avoid this round trip,
 * but Gmail rewrites that header, so the value would be a fiction. One extra
 * metadata read is the honest way to learn what actually went out.
 *
 * Best-effort: a failure here costs thread matching on this one message, and
 * must never turn a delivered email into a reported failure.
 */
async function fetchRfcMessageId(
  gmail: ReturnType<typeof getGmailClient>,
  id: string
): Promise<string | undefined> {
  try {
    const res = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["Message-Id"],
    });
    const header = res.data.payload?.headers?.find(
      (h) => h.name?.toLowerCase() === "message-id"
    );
    return header?.value?.trim() || undefined;
  } catch (err) {
    const code = err instanceof Error ? err.name : "UnknownError";
    console.error("[GmailSender] could not read back Message-Id:", code); // crew-debug-ok
    return undefined;
  }
}

/**
 * El código HTTP que Google devolvió, si lo devolvió.
 *
 * `googleapis` lo pone en tres lugares distintos según por dónde falle: en
 * `err.status`, en `err.code` (a veces número, a veces la cadena de undici como
 * `ECONNRESET`) y en `err.response.status`. Se miran los tres porque el que
 * está es justamente el que dice qué pasó.
 */
function errorStatus(err: unknown): number | string | undefined {
  const e = err as {
    status?: number;
    code?: number | string;
    response?: { status?: number };
  };
  return e?.status ?? e?.response?.status ?? e?.code;
}

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

      return { providerMessageId, rfcMessageId: await fetchRfcMessageId(gmail, providerMessageId) };
    } catch (err) {
      /*
       * El MOTIVO, no una constante.
       *
       * Esto devolvía `GMAIL_SEND_FAILED` para todo y logueaba `err.name`, que
       * para un error de `googleapis` es siempre «GaxiosError» o «Error». O sea
       * que el 401 (token revocado), el 403 (cuota del proyecto), el 429 (tope
       * de Gmail), el 400 (destinatario inválido) y un `ECONNRESET` producían la
       * misma línea de log y la misma fila en la base.
       *
       * No es teórico. En producción, entre el 24 y el 28 de junio de 2026 hay
       * 115 eventos `email.outbound_failed` con el payload IDÉNTICO
       * —`{"error": "GMAIL_SEND_FAILED"}`, los 115— contra 195 enviados. Ciento
       * quince personas que denunciaron un siniestro y no recibieron respuesta
       * durante cuatro días, y de por qué no queda nada: los `console.error` de
       * esos días ya no existen, que la retención de Hobby es de una hora.
       *
       * Con el status propagado, ese incidente habría dicho `GMAIL_401` en las
       * 115 filas de `audit_log`, que están guardadas y no vencen. La diferencia
       * entre «algo falló» y «el token está revocado, andá a reconectar la
       * casilla».
       *
       * Sigue sin loguearse nada del mensaje ni de la credencial (AC10): un
       * código HTTP no es ninguna de las dos cosas.
       */
      const status = errorStatus(err);
      const code = err instanceof Error ? err.name : "UnknownError";
      console.error(
        JSON.stringify({
          level: "error",
          service: "claimmix",
          msg: "gmail_sender.send_failed",
          status: status ?? null,
          error_name: code,
        })
      ); // crew-debug-ok
      return { errorCode: status ? `GMAIL_${status}` : "GMAIL_SEND_FAILED" };
    }
  }
}
