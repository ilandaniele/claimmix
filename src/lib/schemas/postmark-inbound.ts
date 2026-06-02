/**
 * Zod schema for the Postmark inbound webhook payload.
 *
 * Postmark sends a JSON POST to /api/intake/email when an email is received
 * on a configured inbound server. This schema validates the full payload
 * shape before any processing occurs.
 *
 * Reference: https://postmarkapp.com/developer/webhooks/inbound-webhook
 *
 * LLM02 / AC1: All LLM input (email body) comes through this schema — only
 *              validated and typed data reaches the extraction pipeline.
 *
 * PII fields (from_full.Email, subject, text_body, html_body) are never
 * logged to stdout. They flow only to raw_messages (DB) and the AI prompt.
 */

import { z } from "zod";

/** A name+email pair as returned by Postmark for From/To/CC/BCC. */
export const PostmarkAddressSchema = z.object({
  Email: z.string().email(),
  Name: z.string().default(""),
  MailboxHash: z.string().default(""),
});

export type PostmarkAddress = z.infer<typeof PostmarkAddressSchema>;

/** A single email header key-value pair. */
export const PostmarkHeaderSchema = z.object({
  Name: z.string(),
  Value: z.string(),
});

export type PostmarkHeader = z.infer<typeof PostmarkHeaderSchema>;

/**
 * A single attachment as described by Postmark.
 * ContentLength is in bytes. ContentURL is a Postmark CDN link (expires ~7 days).
 * ContentID is only present for inline (embedded) attachments.
 */
export const PostmarkAttachmentSchema = z.object({
  Name: z.string(),
  Content: z.string().default(""),     // base64 encoded — may be empty if ContentURL is used
  ContentType: z.string(),
  ContentLength: z.number().int().min(0),
  ContentURL: z.string().default(""),  // Postmark CDN URL
  ContentID: z.string().default(""),   // present only for inline attachments
});

export type PostmarkAttachment = z.infer<typeof PostmarkAttachmentSchema>;

/**
 * Full Postmark inbound webhook payload.
 *
 * All fields match Postmark's documented shape exactly.
 * Fields that may be absent are marked optional (not required by Postmark).
 */
export const PostmarkInboundSchema = z.object({
  /** Unique MessageID assigned by Postmark. Used for idempotency. */
  MessageID: z.string().min(1),

  /** Parsed From header — name + email of the sender. [PII] */
  FromFull: PostmarkAddressSchema,

  /** Raw From header string (e.g. "Juan Pérez <juan@example.com>"). [PII] */
  From: z.string(),

  /** Array of To address objects. */
  ToFull: z.array(PostmarkAddressSchema).default([]),

  /** Raw To header string. */
  To: z.string().default(""),

  /** CC addresses (if present). */
  CcFull: z.array(PostmarkAddressSchema).default([]),

  /** BCC addresses (if present). */
  BccFull: z.array(PostmarkAddressSchema).default([]),

  /** Email subject line. [PII] */
  Subject: z.string().default(""),

  /** Plain-text body of the email. [PII] */
  TextBody: z.string().default(""),

  /** HTML body of the email (may be empty if sender sent text-only). [PII] */
  HtmlBody: z.string().default(""),

  /**
   * Stripped text body — Postmark removes quoted reply text.
   * Useful as the primary extraction input to reduce prompt token usage.
   */
  StrippedTextReply: z.string().default(""),

  /**
   * Message-ID of the email this is a reply to.
   * Used for thread detection (IC10, AC4).
   */
  InReplyTo: z.string().default(""),

  /**
   * Space-separated list of Message-IDs forming the thread chain.
   * Used alongside InReplyTo for thread lookup.
   */
  References: z.string().default(""),

  /** Date the email was received (RFC 2822 string). */
  Date: z.string().default(""),

  /** Postmark inbound server tag (configured in Postmark UI). */
  Tag: z.string().default(""),

  /** Inbound server hash identifier. */
  MailboxHash: z.string().default(""),

  /** All email headers as an array of {Name, Value} objects. */
  Headers: z.array(PostmarkHeaderSchema).default([]),

  /** Attachments included with the email (AC23). */
  Attachments: z.array(PostmarkAttachmentSchema).default([]),

  /** Original recipient (the inbound address this email was sent to). */
  OriginalRecipient: z.string().default(""),
});

export type PostmarkInboundPayload = z.infer<typeof PostmarkInboundSchema>;

/**
 * Extract the plain-text body to use as AI extraction input.
 * Preference order: StrippedTextReply → TextBody → (strip HTML tags from HtmlBody)
 * Cap at 10,000 characters to limit prompt token usage.
 */
export function extractEmailBody(payload: PostmarkInboundPayload): string {
  const MAX_BODY_CHARS = 10_000;

  if (payload.StrippedTextReply.trim().length > 0) {
    return payload.StrippedTextReply.trim().slice(0, MAX_BODY_CHARS);
  }

  if (payload.TextBody.trim().length > 0) {
    return payload.TextBody.trim().slice(0, MAX_BODY_CHARS);
  }

  // Fallback: strip HTML tags from HtmlBody
  const stripped = payload.HtmlBody.replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return stripped.slice(0, MAX_BODY_CHARS);
}

/**
 * Extract thread identifiers from the Postmark payload.
 * InReplyTo is the primary identifier; References provides fallback chain.
 *
 * Returns the first non-empty identifier found, normalized (trimmed, angle-brackets removed).
 */
export function extractThreadId(payload: PostmarkInboundPayload): string | null {
  const normalize = (s: string) =>
    s.trim().replace(/^</, "").replace(/>$/, "").trim() || null;

  if (payload.InReplyTo) {
    const normalized = normalize(payload.InReplyTo);
    if (normalized) return normalized;
  }

  if (payload.References) {
    // References is a space-separated list; take the first one
    const first = payload.References.trim().split(/\s+/)[0];
    if (first) {
      const normalized = normalize(first);
      if (normalized) return normalized;
    }
  }

  return null;
}
