/**
 * Gmail attachment adapter — converts Gmail MessagePart[] to the
 * PostmarkAttachment-compatible shape expected by rehost-attachments.ts.
 *
 * IC5: rehost-attachments.ts stays unchanged. This adapter produces the
 * { Name, Content, ContentType, ContentLength } shape that rehostAttachments()
 * consumes. Content is standard base64 (Buffer.from(Content, 'base64')).
 *
 * Gmail delivers attachment data as base64url (RFC 4648 §5 — uses - and _ instead
 * of + and /). Standard base64 uses + and /. The adapter converts by replacing
 * - with + and _ with / before handing off to rehostAttachments.
 *
 * For large attachments, Gmail omits part.body.data and sets part.body.attachmentId
 * instead. The adapter fetches the full data via users.messages.attachments.get and
 * converts it to standard base64.
 *
 * AC4:  Correct base64url → base64 conversion.
 * AC14: Content passed to rehostAttachments is decodable via Buffer.from(x, 'base64').
 * AC12: Only this file (within gmail/) calls the Gmail API — no googleapis imports
 *       outside src/server/email/gmail/.
 */

import "server-only";
import type { gmail_v1 } from "googleapis";
import type { PostmarkAttachment } from "@/server/email/rehost-attachments";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Minimal shape of the Gmail API client needed for attachment fetching.
 * Using a structural type so tests can inject a mock without importing googleapis.
 */
export interface GmailAttachmentFetcher {
  users: {
    messages: {
      attachments: {
        get(params: {
          userId: string;
          messageId: string;
          id: string;
        }): Promise<{ data: { data?: string | null; size?: number | null } }>;
      };
    };
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert base64url to standard base64.
 *
 * Gmail API delivers attachment data in base64url encoding (RFC 4648 §5):
 *   - uses - instead of + (char 62)
 *   - uses _ instead of / (char 63)
 *   - no = padding required
 *
 * rehostAttachments.ts decodes via Buffer.from(Content, 'base64') which expects
 * standard base64, so we must convert before returning.
 */
export function base64urlToBase64(b64url: string): string {
  return b64url.replace(/-/g, "+").replace(/_/g, "/");
}

/**
 * Approximate the decoded byte length from a base64 string length.
 * Each base64 char represents 6 bits; 4 chars = 3 bytes.
 * Math.ceil handles partial groups.
 */
function approximateByteLength(b64: string): number {
  // Strip padding characters before computing
  const stripped = b64.replace(/=/g, "");
  return Math.ceil((stripped.length * 3) / 4);
}

/**
 * Determine whether a MessagePart is a real attachment (not an inline image
 * without a meaningful filename).
 *
 * Rules:
 *  - Must have a non-empty filename
 *  - Must NOT have Content-Disposition: inline (inline images embedded in HTML)
 *    unless the filename is still meaningful. We skip parts where disposition
 *    is 'inline' AND the filename looks like a generated cid reference (empty
 *    or matches pattern like 'image001.png' when it's clearly a cid embed).
 *
 * For simplicity: we include a part as an attachment if it has a non-empty
 * filename. Inline images without a real filename are already excluded because
 * filename will be undefined or empty for auto-generated cid attachments.
 */
function isAttachmentPart(part: gmail_v1.Schema$MessagePart): boolean {
  if (!part.filename || part.filename.trim() === "") return false;

  // Skip parts with Content-Disposition: inline that have no body data
  // and no attachmentId (truly embedded images not addressable by the user).
  const disposition = (part.headers ?? [])
    .find((h) => h.name?.toLowerCase() === "content-disposition")
    ?.value?.toLowerCase() ?? "";

  // Allow inline parts if they have a real filename and a body reference —
  // some email clients send inline PDFs. Only skip when disposition is
  // 'inline' AND there's no body data/attachmentId to fetch.
  if (
    disposition.startsWith("inline") &&
    !part.body?.data &&
    !part.body?.attachmentId
  ) {
    return false;
  }

  return true;
}

/**
 * Recursively walk a MessagePart tree and collect all attachment parts.
 * Gmail structures multipart emails as a tree — we must recurse into sub-parts.
 */
function collectAttachmentParts(
  part: gmail_v1.Schema$MessagePart
): gmail_v1.Schema$MessagePart[] {
  const results: gmail_v1.Schema$MessagePart[] = [];

  if (isAttachmentPart(part)) {
    results.push(part);
  }

  // Recurse into sub-parts (multipart/mixed, multipart/related, etc.)
  for (const subPart of part.parts ?? []) {
    results.push(...collectAttachmentParts(subPart));
  }

  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert Gmail MessagePart[] to the PostmarkAttachment shape expected by
 * rehostAttachments().
 *
 * @param parts      Top-level message parts from gmail_v1.Schema$Message.payload.
 * @param messageId  Gmail message ID — required for attachmentId fetches.
 * @param gmail      Gmail API client — used to fetch large attachment bodies.
 * @returns          Array of PostmarkAttachment objects with standard base64 Content.
 */
export async function adaptGmailAttachments(
  parts: gmail_v1.Schema$MessagePart[],
  messageId: string,
  gmail: GmailAttachmentFetcher
): Promise<PostmarkAttachment[]> {
  const results: PostmarkAttachment[] = [];

  // Collect attachment parts from the entire part tree.
  const attachmentParts: gmail_v1.Schema$MessagePart[] = [];
  for (const part of parts) {
    attachmentParts.push(...collectAttachmentParts(part));
  }

  for (const part of attachmentParts) {
    const filename = part.filename!; // guaranteed non-empty by isAttachmentPart
    const mimeType = part.mimeType ?? "application/octet-stream";

    let base64Data: string;

    if (part.body?.data) {
      // Inline data — convert base64url to standard base64.
      base64Data = base64urlToBase64(part.body.data);
    } else if (part.body?.attachmentId) {
      // Large attachment — fetch from Gmail API.
      try {
        const response = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId,
          id: part.body.attachmentId,
        });
        const rawData = response.data.data ?? "";
        base64Data = base64urlToBase64(rawData);
      } catch (err) {
        // Log error code only — no PII (filename is not PII, but body content is).
        const code = err instanceof Error ? err.name : "UnknownError";
        console.error("[gmail-attachment-adapter] Failed to fetch attachment:", code); // crew-debug-ok
        // Skip this attachment rather than failing the whole message.
        continue;
      }
    } else {
      // No data — empty attachment body; skip.
      continue;
    }

    const contentLength = approximateByteLength(base64Data);

    results.push({
      Name: filename,
      Content: base64Data,
      ContentType: mimeType,
      ContentLength: contentLength,
    });
  }

  return results;
}
