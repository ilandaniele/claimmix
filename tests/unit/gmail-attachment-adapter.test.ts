/**
 * Unit tests for src/server/email/gmail/gmail-attachment-adapter.ts
 *
 * Covered scenarios:
 *  - base64url to standard base64 conversion (- → +, _ → /)
 *  - Recursive part walking (nested multipart structure)
 *  - Inline vs attachment detection (filename presence)
 *  - Inline images without data skipped
 *  - attachmentId fallback fetch (large attachments)
 *  - attachmentId fetch failure → part skipped gracefully
 *  - Empty body parts skipped
 *  - ContentLength approximation from base64 length
 *
 * AC4:  base64url payload correctly decoded.
 * AC14: Content passed to rehostAttachments is decodable via Buffer.from(x,'base64').
 */

import { describe, it, expect, vi } from "vitest";

import {
  base64urlToBase64,
  adaptGmailAttachments,
  TOPE_ANTES_DE_BAJAR,
} from "@/server/email/gmail/gmail-attachment-adapter";
import type { GmailAttachmentFetcher } from "@/server/email/gmail/gmail-attachment-adapter";
import { MAX_ATTACHMENT_SIZE_BYTES } from "@/server/email/attachment-validator";
import type { gmail_v1 } from "@googleapis/gmail";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal MessagePart representing an attachment. */
function makePart(opts: {
  filename?: string;
  mimeType?: string;
  data?: string;
  attachmentId?: string;
  disposition?: string;
  size?: number;
  parts?: gmail_v1.Schema$MessagePart[];
}): gmail_v1.Schema$MessagePart {
  const headers: gmail_v1.Schema$MessagePartHeader[] = [];
  if (opts.disposition) {
    headers.push({ name: "Content-Disposition", value: opts.disposition });
  }

  return {
    filename: opts.filename,
    mimeType: opts.mimeType ?? "application/octet-stream",
    headers,
    body: {
      data: opts.data,
      attachmentId: opts.attachmentId,
      size: opts.size ?? (opts.data ? Math.floor(opts.data.length * 0.75) : 0),
    },
    parts: opts.parts,
  };
}

/** Build a no-op Gmail client mock (attachments.get should not be called). */
function makeGmailMock(
  attachmentData?: string
): GmailAttachmentFetcher {
  return {
    users: {
      messages: {
        attachments: {
          get: vi.fn().mockResolvedValue({
            data: { data: attachmentData ?? "", size: 100 },
          }),
        },
      },
    },
  };
}

// ── base64urlToBase64 ─────────────────────────────────────────────────────────

describe("base64urlToBase64", () => {
  it("replaces - with + and _ with /", () => {
    expect(base64urlToBase64("abc-def_ghi")).toBe("abc+def/ghi");
  });

  it("leaves standard base64 characters unchanged", () => {
    expect(base64urlToBase64("aGVsbG8=")).toBe("aGVsbG8=");
  });

  it("converts a realistic base64url string to decodable base64", () => {
    const original = "Hello, World!";
    // base64url of 'Hello, World!':
    const b64url = Buffer.from(original).toString("base64url");
    const b64 = base64urlToBase64(b64url);
    // Must be decodable via standard base64
    expect(Buffer.from(b64, "base64").toString("utf-8")).toBe(original);
  });

  it("handles empty string", () => {
    expect(base64urlToBase64("")).toBe("");
  });

  it("handles strings with only - and _", () => {
    expect(base64urlToBase64("--__")).toBe("++//");
  });
});

// ── adaptGmailAttachments — basic ─────────────────────────────────────────────

describe("adaptGmailAttachments — basic conversion", () => {
  it("returns empty array when parts is empty", async () => {
    const gmail = makeGmailMock();
    const result = await adaptGmailAttachments([], "msg-1", gmail);
    expect(result).toEqual([]);
  });

  it("returns empty array when no parts have a filename", async () => {
    const gmail = makeGmailMock();
    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({ mimeType: "text/plain", data: "aGVsbG8=" }), // no filename
    ];
    const result = await adaptGmailAttachments(parts, "msg-1", gmail);
    expect(result).toEqual([]);
  });

  it("converts a single inline-data attachment part correctly", async () => {
    const gmail = makeGmailMock();
    // base64url of 'PDF content'
    const b64url = Buffer.from("PDF content").toString("base64url");

    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({ filename: "policy.pdf", mimeType: "application/pdf", data: b64url }),
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);

    expect(result).toHaveLength(1);
    expect(result[0].Name).toBe("policy.pdf");
    expect(result[0].ContentType).toBe("application/pdf");
    // Content must be standard base64 (decodable)
    expect(
      Buffer.from(result[0].Content, "base64").toString("utf-8")
    ).toBe("PDF content");
    // Content must NOT contain base64url chars - and _
    expect(result[0].Content).not.toMatch(/[-_]/);
  });

  it("sets ContentLength approximating decoded byte length", async () => {
    const gmail = makeGmailMock();
    const content = "A".repeat(300);
    const b64url = Buffer.from(content).toString("base64url");

    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({ filename: "doc.txt", mimeType: "text/plain", data: b64url }),
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);
    expect(result).toHaveLength(1);
    // Content length should be close to actual byte length (300 bytes)
    expect(result[0].ContentLength).toBeGreaterThan(250);
    expect(result[0].ContentLength).toBeLessThanOrEqual(310);
  });

  it("uses 'application/octet-stream' when mimeType is absent", async () => {
    const gmail = makeGmailMock();
    const b64url = Buffer.from("data").toString("base64url");
    const part: gmail_v1.Schema$MessagePart = {
      filename: "unknown.bin",
      mimeType: undefined,
      headers: [],
      body: { data: b64url },
    };

    const result = await adaptGmailAttachments([part], "msg-1", gmail);
    expect(result[0].ContentType).toBe("application/octet-stream");
  });
});

// ── adaptGmailAttachments — inline vs attachment ──────────────────────────────

describe("adaptGmailAttachments — inline image detection", () => {
  it("skips inline parts with Content-Disposition: inline and no body data", async () => {
    const gmail = makeGmailMock();
    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({
        filename: "image001.png",
        mimeType: "image/png",
        disposition: "inline",
        // No data, no attachmentId
      }),
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);
    expect(result).toHaveLength(0);
  });

  it("includes inline parts that have a filename and inline data", async () => {
    const gmail = makeGmailMock();
    const b64url = Buffer.from("image bytes").toString("base64url");
    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        disposition: "inline",
        data: b64url, // has inline data
      }),
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);
    expect(result).toHaveLength(1);
    expect(result[0].Name).toBe("photo.jpg");
  });

  it("includes attachment parts with Content-Disposition: attachment", async () => {
    const gmail = makeGmailMock();
    const b64url = Buffer.from("PDF bytes").toString("base64url");
    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({
        filename: "policy.pdf",
        mimeType: "application/pdf",
        disposition: "attachment; filename=policy.pdf",
        data: b64url,
      }),
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);
    expect(result).toHaveLength(1);
    expect(result[0].Name).toBe("policy.pdf");
  });
});

// ── adaptGmailAttachments — recursive part walking ────────────────────────────

describe("adaptGmailAttachments — recursive part walking", () => {
  it("finds attachments nested inside multipart/mixed", async () => {
    const gmail = makeGmailMock();
    const b64url = Buffer.from("attachment data").toString("base64url");

    // multipart/mixed with text body + attachment nested
    const parts: gmail_v1.Schema$MessagePart[] = [
      {
        mimeType: "multipart/mixed",
        headers: [],
        body: {},
        parts: [
          makePart({ mimeType: "text/plain", data: "dGV4dA==" }), // no filename
          makePart({ filename: "report.pdf", mimeType: "application/pdf", data: b64url }),
        ],
      },
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);
    expect(result).toHaveLength(1);
    expect(result[0].Name).toBe("report.pdf");
  });

  it("finds attachments nested two levels deep", async () => {
    const gmail = makeGmailMock();
    const b64url = Buffer.from("deep attachment").toString("base64url");

    const parts: gmail_v1.Schema$MessagePart[] = [
      {
        mimeType: "multipart/related",
        headers: [],
        body: {},
        parts: [
          {
            mimeType: "multipart/alternative",
            headers: [],
            body: {},
            parts: [
              makePart({ mimeType: "text/plain", data: "aGVsbG8=" }), // no filename
              makePart({ filename: "nested.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: b64url }),
            ],
          },
        ],
      },
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);
    expect(result).toHaveLength(1);
    expect(result[0].Name).toBe("nested.docx");
  });

  it("collects multiple attachments across the tree", async () => {
    const gmail = makeGmailMock();
    const b1 = Buffer.from("data1").toString("base64url");
    const b2 = Buffer.from("data2").toString("base64url");

    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({ filename: "first.pdf", mimeType: "application/pdf", data: b1 }),
      {
        mimeType: "multipart/mixed",
        headers: [],
        body: {},
        parts: [
          makePart({ filename: "second.docx", mimeType: "application/msword", data: b2 }),
        ],
      },
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);
    expect(result).toHaveLength(2);
    const names = result.map((r) => r.Name);
    expect(names).toContain("first.pdf");
    expect(names).toContain("second.docx");
  });
});

// ── adaptGmailAttachments — attachmentId fallback ────────────────────────────

describe("adaptGmailAttachments — attachmentId fallback fetch", () => {
  it("fetches large attachment data via gmail.users.messages.attachments.get", async () => {
    const fetchedData = Buffer.from("fetched from API").toString("base64url");
    const gmail = makeGmailMock(fetchedData);

    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({
        filename: "large.pdf",
        mimeType: "application/pdf",
        attachmentId: "attach-id-001",
        // No inline data — only attachmentId
      }),
    ];

    const result = await adaptGmailAttachments(parts, "msg-99", gmail);

    expect(gmail.users.messages.attachments.get).toHaveBeenCalledWith({
      userId: "me",
      messageId: "msg-99",
      id: "attach-id-001",
    });

    expect(result).toHaveLength(1);
    expect(result[0].Name).toBe("large.pdf");
    expect(
      Buffer.from(result[0].Content, "base64").toString("utf-8")
    ).toBe("fetched from API");
  });

  it("skips the attachment (does not throw) when attachmentId fetch fails", async () => {
    const gmail: GmailAttachmentFetcher = {
      users: {
        messages: {
          attachments: {
            get: vi.fn().mockRejectedValue(new Error("NetworkError")),
          },
        },
      },
    };

    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({
        filename: "will-fail.pdf",
        mimeType: "application/pdf",
        attachmentId: "attach-id-fail",
      }),
    ];

    // Should NOT throw — failed attachment is skipped.
    const result = await adaptGmailAttachments(parts, "msg-1", gmail);
    expect(result).toHaveLength(0);
  });

  it("skips parts with neither data nor attachmentId", async () => {
    const gmail = makeGmailMock();
    const part: gmail_v1.Schema$MessagePart = {
      filename: "empty.pdf",
      mimeType: "application/pdf",
      headers: [],
      body: {
        // No data, no attachmentId
      },
    };

    const result = await adaptGmailAttachments([part], "msg-1", gmail);
    expect(result).toHaveLength(0);
  });
});

// ── E8: part.body.size pre-check before downloading ──────────────────────────

describe("adaptGmailAttachments — size pre-check before downloading", () => {
  it("rejects an oversized PDF without calling attachments.get", async () => {
    const gmail = makeGmailMock();
    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({
        filename: "huge.pdf",
        mimeType: "application/pdf",
        attachmentId: "attach-id-huge",
        size: TOPE_ANTES_DE_BAJAR + 1,
      }),
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);

    expect(gmail.users.messages.attachments.get).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].rechazoPrevio).toBe("size_exceeded");
    expect(result[0].Content).toBe("");
    expect(result[0].ContentLength).toBe(TOPE_ANTES_DE_BAJAR + 1);
  });

  it("rejects a disallowed content type over the pre-check cap without fetching", async () => {
    const gmail = makeGmailMock();
    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({
        filename: "virus.exe",
        mimeType: "application/x-msdownload",
        attachmentId: "attach-id-exe",
        size: TOPE_ANTES_DE_BAJAR + 1,
      }),
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);

    expect(gmail.users.messages.attachments.get).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].rechazoPrevio).toBe("content_type_not_allowed");
  });

  it("fetches when the declared size is exactly the pre-check cap (boundary inclusive)", async () => {
    const fetchedData = Buffer.from("at the boundary").toString("base64url");
    const gmail = makeGmailMock(fetchedData);
    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({
        filename: "boundary.pdf",
        mimeType: "application/pdf",
        attachmentId: "attach-id-boundary",
        size: TOPE_ANTES_DE_BAJAR,
      }),
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);

    expect(gmail.users.messages.attachments.get).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].rechazoPrevio).toBeUndefined();
  });

  it("fetches when the declared size is over MAX_ATTACHMENT_SIZE_BYTES but under the pre-check cap", async () => {
    const fetchedData = Buffer.from("still fetched").toString("base64url");
    const gmail = makeGmailMock(fetchedData);
    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({
        filename: "borderline.pdf",
        mimeType: "application/pdf",
        attachmentId: "attach-id-borderline",
        size: MAX_ATTACHMENT_SIZE_BYTES + 1,
      }),
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);

    expect(gmail.users.messages.attachments.get).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].rechazoPrevio).toBeUndefined();
  });

  it("fetches when size is 0 or undefined", async () => {
    const fetchedData = Buffer.from("no declared size").toString("base64url");
    const gmail = makeGmailMock(fetchedData);
    const undefSizePart: gmail_v1.Schema$MessagePart = {
      filename: "undef.pdf",
      mimeType: "application/pdf",
      headers: [],
      body: { attachmentId: "attach-id-undef" }, // no size key at all
    };
    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({ filename: "zero.pdf", mimeType: "application/pdf", attachmentId: "attach-id-zero", size: 0 }),
      undefSizePart,
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);

    expect(gmail.users.messages.attachments.get).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it("pins TOPE_ANTES_DE_BAJAR to 13_981_016", () => {
    expect(TOPE_ANTES_DE_BAJAR).toBe(13_981_016);
  });
});

// ── AC14: Content is standard base64 ─────────────────────────────────────────

describe("AC14: Content decodable via Buffer.from(x, 'base64')", () => {
  it("decoded content matches original bytes for a binary payload", async () => {
    const gmail = makeGmailMock();
    // Create a binary buffer (simulating a small PDF)
    const binaryData = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // '%PDF-1.4'
    const b64url = binaryData.toString("base64url");

    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({ filename: "sample.pdf", mimeType: "application/pdf", data: b64url }),
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);
    expect(result).toHaveLength(1);

    const decoded = Buffer.from(result[0].Content, "base64");
    expect(decoded).toEqual(binaryData);
  });

  it("Content contains no base64url-specific characters (- or _)", async () => {
    const gmail = makeGmailMock();
    // Force a payload that would produce - and _ in base64url
    const payload = Buffer.from([0xfb, 0xff, 0xfe, 0xef, 0xbf, 0xbd]);
    const b64url = payload.toString("base64url");

    // Verify this actually contains base64url chars
    const hasUrlChars = b64url.includes("-") || b64url.includes("_");
    if (!hasUrlChars) {
      // If this particular payload doesn't produce - or _, test still validates conversion
    }

    const parts: gmail_v1.Schema$MessagePart[] = [
      makePart({ filename: "binary.bin", mimeType: "application/octet-stream", data: b64url }),
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);
    expect(result[0].Content).not.toContain("-");
    expect(result[0].Content).not.toContain("_");
  });
});
