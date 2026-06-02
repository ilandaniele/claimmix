/**
 * Unit tests for PostmarkInboundSchema Zod validation.
 *
 * Tests the schema shape, required fields, optional defaults,
 * and utility functions (extractEmailBody, extractThreadId).
 *
 * AC1: Webhook payload validated before any processing.
 * AC4: Thread ID extracted from InReplyTo / References headers.
 */

import { describe, it, expect } from "vitest";
import {
  PostmarkInboundSchema,
  extractEmailBody,
  extractThreadId,
  type PostmarkInboundPayload,
} from "@/lib/schemas/postmark-inbound";

// ── Minimal valid payload factory ─────────────────────────────────────────────

function makeValidPayload(overrides: Partial<PostmarkInboundPayload> = {}): unknown {
  return {
    MessageID: "msg-abc-123",
    FromFull: { Email: "claimant@example.com", Name: "Juan Pérez", MailboxHash: "" },
    From: "Juan Pérez <claimant@example.com>",
    ToFull: [{ Email: "claims@claimmix.com", Name: "ClaimMix", MailboxHash: "" }],
    To: "claims@claimmix.com",
    CcFull: [],
    BccFull: [],
    Subject: "Choque en Av. Cabildo",
    TextBody: "Tuve un choque en Av. Cabildo 1234 el 01/06/2026.",
    HtmlBody: "",
    StrippedTextReply: "",
    InReplyTo: "",
    References: "",
    Date: "Mon, 02 Jun 2026 10:00:00 -0300",
    Tag: "",
    MailboxHash: "",
    Headers: [],
    Attachments: [],
    OriginalRecipient: "claims@claimmix.com",
    ...overrides,
  };
}

// ── Valid payloads ────────────────────────────────────────────────────────────

describe("PostmarkInboundSchema — valid payloads", () => {
  it("parses a minimal valid payload", () => {
    const result = PostmarkInboundSchema.safeParse(makeValidPayload());
    expect(result.success).toBe(true);
  });

  it("parses payload with attachments", () => {
    const payload = makeValidPayload({
      Attachments: [
        {
          Name: "denuncia.pdf",
          Content: "",
          ContentType: "application/pdf",
          ContentLength: 102400,
          ContentURL: "https://phcdn.postmarkapp.com/attachment/xxx",
          ContentID: "",
        },
      ],
    });
    const result = PostmarkInboundSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.Attachments).toHaveLength(1);
      expect(result.data.Attachments[0]!.Name).toBe("denuncia.pdf");
      expect(result.data.Attachments[0]!.ContentLength).toBe(102400);
    }
  });

  it("parses payload with InReplyTo header", () => {
    const payload = makeValidPayload({
      InReplyTo: "<original-msg-id@mail.example.com>",
      References: "<original-msg-id@mail.example.com>",
    });
    const result = PostmarkInboundSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.InReplyTo).toBe("<original-msg-id@mail.example.com>");
    }
  });

  it("parses payload with HtmlBody only (no TextBody)", () => {
    const payload = makeValidPayload({
      TextBody: "",
      HtmlBody: "<p>Tuve un choque en Av. Cabildo.</p>",
    });
    const result = PostmarkInboundSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("defaults missing optional fields to empty strings / empty arrays", () => {
    const minimal = {
      MessageID: "msg-minimal",
      FromFull: { Email: "a@b.com", Name: "", MailboxHash: "" },
      From: "a@b.com",
    };
    const result = PostmarkInboundSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.TextBody).toBe("");
      expect(result.data.Attachments).toEqual([]);
      expect(result.data.Headers).toEqual([]);
      expect(result.data.Subject).toBe("");
    }
  });
});

// ── Invalid payloads ──────────────────────────────────────────────────────────

describe("PostmarkInboundSchema — invalid payloads", () => {
  it("rejects missing MessageID", () => {
    const payload = makeValidPayload({ MessageID: "" });
    const result = PostmarkInboundSchema.safeParse({ ...payload, MessageID: "" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid From email in FromFull", () => {
    const payload = {
      ...makeValidPayload(),
      FromFull: { Email: "not-an-email", Name: "Bad", MailboxHash: "" },
    };
    const result = PostmarkInboundSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects null payload", () => {
    const result = PostmarkInboundSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("rejects non-object payload", () => {
    const result = PostmarkInboundSchema.safeParse("not-an-object");
    expect(result.success).toBe(false);
  });

  it("rejects attachment with negative ContentLength", () => {
    const payload = makeValidPayload({
      Attachments: [
        {
          Name: "file.pdf",
          Content: "",
          ContentType: "application/pdf",
          ContentLength: -1,
          ContentURL: "",
          ContentID: "",
        },
      ],
    });
    const result = PostmarkInboundSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

// ── extractEmailBody ──────────────────────────────────────────────────────────

describe("extractEmailBody", () => {
  it("returns StrippedTextReply when non-empty (preferred)", () => {
    const payload = PostmarkInboundSchema.parse(makeValidPayload({
      StrippedTextReply: "Stripped reply text.",
      TextBody: "Full text body with quoted reply.",
    }));
    expect(extractEmailBody(payload)).toBe("Stripped reply text.");
  });

  it("falls back to TextBody when StrippedTextReply is empty", () => {
    const payload = PostmarkInboundSchema.parse(makeValidPayload({
      StrippedTextReply: "  ",
      TextBody: "Tuve un choque en Av. Cabildo 1234.",
      HtmlBody: "",
    }));
    expect(extractEmailBody(payload)).toBe("Tuve un choque en Av. Cabildo 1234.");
  });

  it("strips HTML tags when only HtmlBody is available", () => {
    const payload = PostmarkInboundSchema.parse(makeValidPayload({
      StrippedTextReply: "",
      TextBody: "",
      HtmlBody: "<p>Tuve un <b>choque</b> en Av. Cabildo.</p>",
    }));
    const body = extractEmailBody(payload);
    expect(body).toContain("choque");
    expect(body).not.toContain("<p>");
    expect(body).not.toContain("<b>");
  });

  it("truncates body at 10,000 characters", () => {
    const longBody = "a".repeat(15_000);
    const payload = PostmarkInboundSchema.parse(makeValidPayload({
      TextBody: longBody,
    }));
    const body = extractEmailBody(payload);
    expect(body.length).toBe(10_000);
  });

  it("returns empty string when all body fields are empty", () => {
    const payload = PostmarkInboundSchema.parse(makeValidPayload({
      StrippedTextReply: "",
      TextBody: "",
      HtmlBody: "",
    }));
    expect(extractEmailBody(payload)).toBe("");
  });
});

// ── extractThreadId ───────────────────────────────────────────────────────────

describe("extractThreadId", () => {
  it("returns InReplyTo normalized (angle brackets removed)", () => {
    const payload = PostmarkInboundSchema.parse(makeValidPayload({
      InReplyTo: "<thread-abc@mail.example.com>",
    }));
    expect(extractThreadId(payload)).toBe("thread-abc@mail.example.com");
  });

  it("falls back to first References entry when InReplyTo is empty", () => {
    const payload = PostmarkInboundSchema.parse(makeValidPayload({
      InReplyTo: "",
      References: "<ref-1@mail.example.com> <ref-2@mail.example.com>",
    }));
    expect(extractThreadId(payload)).toBe("ref-1@mail.example.com");
  });

  it("returns null when both InReplyTo and References are empty", () => {
    const payload = PostmarkInboundSchema.parse(makeValidPayload({
      InReplyTo: "",
      References: "",
    }));
    expect(extractThreadId(payload)).toBeNull();
  });

  it("handles InReplyTo without angle brackets", () => {
    const payload = PostmarkInboundSchema.parse(makeValidPayload({
      InReplyTo: "plain-id@mail.example.com",
    }));
    expect(extractThreadId(payload)).toBe("plain-id@mail.example.com");
  });

  it("returns null for whitespace-only InReplyTo", () => {
    const payload = PostmarkInboundSchema.parse(makeValidPayload({
      InReplyTo: "   ",
      References: "",
    }));
    expect(extractThreadId(payload)).toBeNull();
  });
});
