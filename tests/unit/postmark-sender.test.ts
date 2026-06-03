/**
 * Unit tests for PostmarkSender.
 *
 * Mocks the postmark ServerClient to avoid real API calls.
 * Each test creates a fresh PostmarkSender instance so the lazy-init
 * singleton (_client) is reset.
 *
 * AC13: Only POSTMARK_SERVER_TOKEN / POSTMARK_FROM_ADDRESS are read (no Resend vars).
 * AC16: In-Reply-To and References headers are forwarded to Postmark's Headers array.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SendEmailOptions } from "../../src/server/email/provider";

// ── Mock postmark module ───────────────────────────────────────────────────────
// We use a mutable object so the mock function reference is stable across test resets.
// vi.mock is hoisted — runs before any imports, including the dynamic import below.

const mockClient = {
  sendEmail: vi.fn(),
};

vi.mock("postmark", () => ({
  // Use a regular function (not arrow) to satisfy Vitest's constructor mock requirement.
  ServerClient: vi.fn(function () {
    return mockClient;
  }),
}));

// Import PostmarkSender AFTER the mock is set up.
const { PostmarkSender } = await import("../../src/server/email/postmark/postmark-sender");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOpts(overrides: Partial<SendEmailOptions> = {}): SendEmailOptions {
  return {
    to: "claimant@example.com",
    from: "claims@company.com",
    subject: "Your claim has been received",
    textBody: "Plain text body",
    htmlBody: "<p>HTML body</p>",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PostmarkSender.send()", () => {
  beforeEach(() => {
    // Reset only sendEmail call history — preserves mock implementation.
    mockClient.sendEmail.mockReset();
    process.env.POSTMARK_SERVER_TOKEN = "test-token-123";
    process.env.POSTMARK_FROM_ADDRESS = "claims@company.com";
  });

  afterEach(() => {
    delete process.env.POSTMARK_SERVER_TOKEN;
    delete process.env.POSTMARK_FROM_ADDRESS;
  });

  it("returns providerMessageId on success", async () => {
    mockClient.sendEmail.mockResolvedValueOnce({ MessageID: "pm-msg-id-abc" });

    const sender = new PostmarkSender();
    const result = await sender.send(makeOpts());

    expect(result).toEqual({ providerMessageId: "pm-msg-id-abc" });
    expect(mockClient.sendEmail).toHaveBeenCalledOnce();
  });

  it("returns errorCode when Postmark throws an error with ErrorCode", async () => {
    const postmarkError = new Error("Bad request");
    (postmarkError as unknown as { ErrorCode: number }).ErrorCode = 406;
    mockClient.sendEmail.mockRejectedValueOnce(postmarkError);

    const sender = new PostmarkSender();
    const result = await sender.send(makeOpts());

    expect(result).toEqual({ errorCode: "POSTMARK_SEND_FAILED" });
  });

  it("returns errorCode for a generic thrown error (no ErrorCode property)", async () => {
    mockClient.sendEmail.mockRejectedValueOnce(new Error("Network failure"));

    const sender = new PostmarkSender();
    const result = await sender.send(makeOpts());

    expect(result).toEqual({ errorCode: "POSTMARK_SEND_FAILED" });
  });

  it("returns errorCode at send time when POSTMARK_SERVER_TOKEN is missing (lazy-init)", async () => {
    delete process.env.POSTMARK_SERVER_TOKEN;

    // PostmarkSender created without token — getClient() throws at send time.
    const sender = new PostmarkSender();
    const result = await sender.send(makeOpts());

    // Missing token → configuration error caught inside send() → errorCode returned.
    expect(result).toEqual({ errorCode: "POSTMARK_SEND_FAILED" });
    // Postmark API was never actually called.
    expect(mockClient.sendEmail).not.toHaveBeenCalled();
  });

  it("succeeds when opts.from is explicit and POSTMARK_FROM_ADDRESS env var is absent", async () => {
    delete process.env.POSTMARK_FROM_ADDRESS;
    mockClient.sendEmail.mockResolvedValueOnce({ MessageID: "pm-msg-id-xyz" });

    const sender = new PostmarkSender();
    // opts.from is explicitly provided — env var for from address is not needed.
    const result = await sender.send(makeOpts({ from: "explicit@example.com" }));

    expect(result).toEqual({ providerMessageId: "pm-msg-id-xyz" });
  });

  it("AC16: forwards In-Reply-To and References headers to Postmark", async () => {
    mockClient.sendEmail.mockResolvedValueOnce({ MessageID: "pm-reply-msg" });

    const sender = new PostmarkSender();
    const result = await sender.send(
      makeOpts({
        headers: [
          { Name: "In-Reply-To", Value: "in-1" },
          { Name: "References", Value: "in-1" },
        ],
      })
    );

    expect(result).toEqual({ providerMessageId: "pm-reply-msg" });

    const callArgs = mockClient.sendEmail.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs["Headers"]).toEqual([
      { Name: "In-Reply-To", Value: "in-1" },
      { Name: "References", Value: "in-1" },
    ]);
  });

  it("passes textBody, htmlBody, replyTo, and tag to Postmark sendEmail", async () => {
    mockClient.sendEmail.mockResolvedValueOnce({ MessageID: "pm-full-msg" });

    const sender = new PostmarkSender();
    await sender.send(
      makeOpts({
        textBody: "plain text",
        htmlBody: "<b>bold</b>",
        replyTo: "reply@example.com",
        tag: "confirmation",
      })
    );

    const callArgs = mockClient.sendEmail.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs["TextBody"]).toBe("plain text");
    expect(callArgs["HtmlBody"]).toBe("<b>bold</b>");
    expect(callArgs["ReplyTo"]).toBe("reply@example.com");
    expect(callArgs["Tag"]).toBe("confirmation");
  });

  it("provider name is 'postmark'", () => {
    const sender = new PostmarkSender();
    expect(sender.name).toBe("postmark");
  });
});
