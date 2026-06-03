/**
 * Unit tests for GmailSender (AC5 / AC9).
 *
 * Mocks googleapis entirely — no real network calls.
 *
 * Covered scenarios:
 *  - send() success → returns { providerMessageId }
 *  - send() failure (API throws) → returns { errorCode: 'GMAIL_SEND_FAILED' }, no throw
 *  - Missing env vars at construction time → getGmailAuth() throws
 *  - threadId included in requestBody when opts.threadId is provided
 *  - In-Reply-To header from opts.headers is forwarded to raw email
 *  - base64url encoding is used (response.data.id from mock, not raw string)
 *  - name === 'gmail' (AC9)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── googleapis mock ───────────────────────────────────────────────────────────
//
// vi.mock is hoisted before variable declarations, so we use vi.hoisted() to
// define the mock variables before the vi.mock factory runs.

const { mockMessagesSend, MockOAuth2, mockGmailFn } = vi.hoisted(() => {
  const mockMessagesSend = vi.fn();
  // Use function() constructor so Vitest doesn't complain about 'new' on arrow fn
  const MockOAuth2 = vi.fn(function (this: unknown) {
    return { setCredentials: vi.fn() };
  });
  const mockGmailFn = vi.fn();
  return { mockMessagesSend, MockOAuth2, mockGmailFn };
});

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: MockOAuth2,
    },
    gmail: mockGmailFn,
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wire up a fresh gmail mock instance for the current test. */
function setupGmailMock() {
  mockGmailFn.mockReturnValue({
    users: {
      messages: {
        send: mockMessagesSend,
      },
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GmailSender", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-wire the gmail mock after clearAllMocks() resets all mock implementations.
    setupGmailMock();
    // Set required env vars for all tests by default.
    process.env.GMAIL_CLIENT_ID = "test-client-id";
    process.env.GMAIL_CLIENT_SECRET = "test-client-secret";
    process.env.GMAIL_REFRESH_TOKEN = "test-refresh-token";
    process.env.GMAIL_FROM_ADDRESS = "claims@test.com";
  });

  afterEach(async () => {
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.GMAIL_REFRESH_TOKEN;
    delete process.env.GMAIL_FROM_ADDRESS;

    // Reset the gmail-client singleton between tests so env var changes take effect.
    const { resetGmailAuth } = await import(
      "@/server/email/gmail/gmail-client"
    );
    resetGmailAuth();

    // Reset the provider factory singleton.
    const { resetEmailProvider } = await import("@/server/email/gmail/index");
    resetEmailProvider();
  });

  // ── AC9: name === 'gmail' ────────────────────────────────────────────────────

  it("AC9: GmailSender.name === 'gmail'", async () => {
    const { GmailSender } = await import("@/server/email/gmail/gmail-sender");
    const sender = new GmailSender();
    expect(sender.name).toBe("gmail");
  });

  it("AC9: getEmailProvider().name === 'gmail'", async () => {
    // getEmailProvider() lazy-inits GmailSender — provider name must be 'gmail'.
    const { getEmailProvider } = await import("@/server/email/gmail/index");
    const provider = getEmailProvider();
    expect(provider.name).toBe("gmail");
  });

  // ── AC5: send() success ──────────────────────────────────────────────────────

  it("AC5: send() returns { providerMessageId } on success", async () => {
    mockMessagesSend.mockResolvedValueOnce({ data: { id: "gmail-msg-id-1" } });

    const { GmailSender } = await import("@/server/email/gmail/gmail-sender");
    const sender = new GmailSender();

    const result = await sender.send({
      to: "claimant@example.com",
      from: "claims@test.com",
      subject: "Your claim confirmation",
      textBody: "Hello",
    });

    expect(result).toEqual({ providerMessageId: "gmail-msg-id-1" });
  });

  // ── send() failure ───────────────────────────────────────────────────────────

  it("send() failure: returns { errorCode: 'GMAIL_SEND_FAILED' }, does not throw", async () => {
    mockMessagesSend.mockRejectedValueOnce(new Error("Network error"));

    const { GmailSender } = await import("@/server/email/gmail/gmail-sender");
    const sender = new GmailSender();

    // Must not throw — must resolve with errorCode.
    const result = await sender.send({
      to: "claimant@example.com",
      from: "claims@test.com",
      subject: "Test",
      textBody: "Hello",
    });

    expect(result).toEqual({ errorCode: "GMAIL_SEND_FAILED" });
  });

  it("send() failure: returns { errorCode: 'GMAIL_SEND_FAILED' } when API returns no id", async () => {
    // Gmail API call succeeds but returns no message id.
    mockMessagesSend.mockResolvedValueOnce({ data: { id: undefined } });

    const { GmailSender } = await import("@/server/email/gmail/gmail-sender");
    const sender = new GmailSender();

    const result = await sender.send({
      to: "claimant@example.com",
      from: "claims@test.com",
      subject: "Test",
      textBody: "Hello",
    });

    expect(result).toEqual({ errorCode: "GMAIL_SEND_FAILED" });
  });

  // ── Missing env vars ────────────────────────────────────────────────────────

  it("missing env vars: getGmailAuth() throws on first use", async () => {
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.GMAIL_REFRESH_TOKEN;

    const { getGmailAuth, resetGmailAuth } = await import(
      "@/server/email/gmail/gmail-client"
    );
    resetGmailAuth(); // ensure singleton is cleared for this test

    expect(() => getGmailAuth()).toThrow(
      "GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN must be set"
    );
  });

  it("missing env vars: GmailSender.send() propagates the env error as GMAIL_SEND_FAILED", async () => {
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.GMAIL_REFRESH_TOKEN;

    const { resetGmailAuth } = await import("@/server/email/gmail/gmail-client");
    resetGmailAuth();

    const { GmailSender } = await import("@/server/email/gmail/gmail-sender");
    const sender = new GmailSender();

    // send() must not throw — catches the env error internally.
    const result = await sender.send({
      to: "claimant@example.com",
      from: "claims@test.com",
      subject: "Test",
      textBody: "Hello",
    });

    expect(result).toEqual({ errorCode: "GMAIL_SEND_FAILED" });
  });

  // ── AC5: threadId in requestBody ─────────────────────────────────────────────

  it("AC5: threadId is included in requestBody when opts.threadId is provided", async () => {
    mockMessagesSend.mockResolvedValueOnce({ data: { id: "gmail-msg-id-2" } });

    const { GmailSender } = await import("@/server/email/gmail/gmail-sender");
    const sender = new GmailSender();

    await sender.send({
      to: "claimant@example.com",
      from: "claims@test.com",
      subject: "Reply confirmation",
      textBody: "Hello",
      threadId: "thread-T1",
    });

    expect(mockMessagesSend).toHaveBeenCalledOnce();
    const callArg = mockMessagesSend.mock.calls[0][0] as {
      userId: string;
      requestBody: { raw: string; threadId?: string };
    };
    expect(callArg.requestBody.threadId).toBe("thread-T1");
  });

  it("AC5: threadId is NOT included in requestBody when opts.threadId is absent", async () => {
    mockMessagesSend.mockResolvedValueOnce({ data: { id: "gmail-msg-id-3" } });

    const { GmailSender } = await import("@/server/email/gmail/gmail-sender");
    const sender = new GmailSender();

    await sender.send({
      to: "claimant@example.com",
      from: "claims@test.com",
      subject: "New email",
      textBody: "Hello",
      // no threadId
    });

    expect(mockMessagesSend).toHaveBeenCalledOnce();
    const callArg = mockMessagesSend.mock.calls[0][0] as {
      userId: string;
      requestBody: { raw: string; threadId?: string };
    };
    expect(callArg.requestBody.threadId).toBeUndefined();
  });

  // ── In-Reply-To header forwarding ────────────────────────────────────────────

  it("In-Reply-To header from opts.headers is forwarded into the raw RFC 2822 email", async () => {
    mockMessagesSend.mockResolvedValueOnce({ data: { id: "gmail-msg-id-4" } });

    const { GmailSender } = await import("@/server/email/gmail/gmail-sender");
    const sender = new GmailSender();

    await sender.send({
      to: "claimant@example.com",
      from: "claims@test.com",
      subject: "Re: Your claim",
      textBody: "Thank you",
      headers: [
        { Name: "In-Reply-To", Value: "<original-msg-id@mail.gmail.com>" },
        { Name: "References", Value: "<original-msg-id@mail.gmail.com>" },
      ],
    });

    expect(mockMessagesSend).toHaveBeenCalledOnce();
    const callArg = mockMessagesSend.mock.calls[0][0] as {
      userId: string;
      requestBody: { raw: string };
    };

    // Decode the base64url-encoded raw email and verify the header is present.
    const decoded = Buffer.from(callArg.requestBody.raw, "base64url").toString("utf-8");
    expect(decoded).toContain("In-Reply-To: <original-msg-id@mail.gmail.com>");
    expect(decoded).toContain("References: <original-msg-id@mail.gmail.com>");
  });

  // ── base64url encoding verification ──────────────────────────────────────────

  it("uses base64url encoding (response.data.id from mock, not raw email string)", async () => {
    mockMessagesSend.mockResolvedValueOnce({ data: { id: "gmail-msg-id-5" } });

    const { GmailSender } = await import("@/server/email/gmail/gmail-sender");
    const sender = new GmailSender();

    const result = await sender.send({
      to: "claimant@example.com",
      from: "claims@test.com",
      subject: "Test base64url",
      textBody: "Test content",
    });

    // Result must be the mock's response ID, not the base64url string itself.
    expect(result).toEqual({ providerMessageId: "gmail-msg-id-5" });

    const callArg = mockMessagesSend.mock.calls[0][0] as {
      userId: string;
      requestBody: { raw: string };
    };

    const raw = callArg.requestBody.raw;

    // base64url uses - and _ instead of + and /; no = padding.
    // Verify the raw field is a valid base64url string (no standard base64 chars).
    expect(raw).not.toContain("+");
    expect(raw).not.toContain("/");
    // The decoded value must be a valid RFC 2822 email (not the ID 'gmail-msg-id-5').
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("From: claims@test.com");
    expect(decoded).toContain("To: claimant@example.com");
    expect(decoded).toContain("Subject: Test base64url");
  });

  // ── userId='me' ──────────────────────────────────────────────────────────────

  it("calls users.messages.send with userId='me'", async () => {
    mockMessagesSend.mockResolvedValueOnce({ data: { id: "gmail-msg-id-6" } });

    const { GmailSender } = await import("@/server/email/gmail/gmail-sender");
    const sender = new GmailSender();

    await sender.send({
      to: "claimant@example.com",
      from: "claims@test.com",
      subject: "Test userId",
      textBody: "Hello",
    });

    expect(mockMessagesSend).toHaveBeenCalledOnce();
    const callArg = mockMessagesSend.mock.calls[0][0] as { userId: string };
    expect(callArg.userId).toBe("me");
  });

  // ── Multipart/alternative (htmlBody) ─────────────────────────────────────────

  it("builds multipart/alternative email when htmlBody is provided", async () => {
    mockMessagesSend.mockResolvedValueOnce({ data: { id: "gmail-msg-id-7" } });

    const { GmailSender } = await import("@/server/email/gmail/gmail-sender");
    const sender = new GmailSender();

    await sender.send({
      to: "claimant@example.com",
      from: "claims@test.com",
      subject: "HTML Email",
      textBody: "Plain text",
      htmlBody: "<p>HTML content</p>",
    });

    expect(mockMessagesSend).toHaveBeenCalledOnce();
    const callArg = mockMessagesSend.mock.calls[0][0] as {
      requestBody: { raw: string };
    };

    const decoded = Buffer.from(callArg.requestBody.raw, "base64url").toString("utf-8");
    expect(decoded).toContain("Content-Type: multipart/alternative");
    expect(decoded).toContain("Content-Type: text/plain");
    expect(decoded).toContain("Content-Type: text/html");
    expect(decoded).toContain("Plain text");
    expect(decoded).toContain("<p>HTML content</p>");
  });
});
