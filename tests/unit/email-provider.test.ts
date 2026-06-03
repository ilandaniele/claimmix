/**
 * Unit tests for the EmailProvider factory (getEmailProvider / setEmailProvider / resetEmailProvider).
 *
 * Tests the gmail/index.ts factory — the active provider factory as of W1.
 * GmailSender is not yet implemented (W2), so getEmailProvider() throws unless
 * a provider is injected via setEmailProvider(). Tests use mock injection only.
 *
 * Tests that:
 * - getEmailProvider() throws when no provider has been set (no GmailSender yet).
 * - setEmailProvider() overrides the singleton.
 * - resetEmailProvider() clears the singleton.
 * - isSendSuccess() type guard works correctly.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { EmailProvider, SendEmailOptions, SendResult } from "../../src/server/email/provider";
import { isSendSuccess } from "../../src/server/email/provider";

const {
  getEmailProvider,
  setEmailProvider,
  resetEmailProvider,
} = await import("../../src/server/email/gmail/index");

// A simple mock provider for DI tests.
function makeMockProvider(name: "gmail" | "postmark" = "gmail"): EmailProvider {
  return {
    name,
    send: vi.fn<[SendEmailOptions], Promise<SendResult>>().mockResolvedValue({
      providerMessageId: "mock-provider-id",
    }),
  };
}

describe("getEmailProvider()", () => {
  afterEach(() => {
    resetEmailProvider();
  });

  it("throws when no provider has been initialized (W2 GmailSender not yet wired)", () => {
    // No setEmailProvider() call — factory should throw until W2 wires GmailSender.
    expect(() => getEmailProvider()).toThrow(
      "EmailProvider not initialized"
    );
  });

  it("returns injected provider after setEmailProvider()", () => {
    const mock = makeMockProvider("gmail");
    setEmailProvider(mock);

    const provider = getEmailProvider();
    expect(provider).toBeDefined();
    expect(provider.name).toBe("gmail");
    expect(typeof provider.send).toBe("function");
  });

  it("returns the same singleton on repeated calls after injection", () => {
    const mock = makeMockProvider("gmail");
    setEmailProvider(mock);

    const a = getEmailProvider();
    const b = getEmailProvider();

    expect(a).toBe(b);
  });
});

describe("setEmailProvider()", () => {
  afterEach(() => {
    resetEmailProvider();
  });

  it("overrides the singleton with a mock provider", () => {
    const mock = makeMockProvider();
    setEmailProvider(mock);

    const provider = getEmailProvider();
    expect(provider).toBe(mock);
  });

  it("mock provider send() returns expected result", async () => {
    const mock = makeMockProvider();
    setEmailProvider(mock);

    const result = await getEmailProvider().send({
      to: "a@example.com",
      from: "b@example.com",
      subject: "Test",
    });

    expect(result).toEqual({ providerMessageId: "mock-provider-id" });
  });

  it("accepts a provider with name='postmark' (interface allows both names)", () => {
    const mock = makeMockProvider("postmark");
    setEmailProvider(mock);

    expect(getEmailProvider().name).toBe("postmark");
  });
});

describe("resetEmailProvider()", () => {
  it("clears the singleton so next call throws (until W2 wires GmailSender)", () => {
    const mock = makeMockProvider();
    setEmailProvider(mock);

    resetEmailProvider();

    expect(() => getEmailProvider()).toThrow("EmailProvider not initialized");
  });

  it("after reset, setEmailProvider injection works again", () => {
    const mock1 = makeMockProvider();
    setEmailProvider(mock1);
    resetEmailProvider();

    const mock2 = makeMockProvider();
    setEmailProvider(mock2);

    expect(getEmailProvider()).toBe(mock2);
    resetEmailProvider();
  });
});

describe("isSendSuccess()", () => {
  it("returns true when result has providerMessageId", () => {
    const result: SendResult = { providerMessageId: "abc" };
    expect(isSendSuccess(result)).toBe(true);
  });

  it("returns false when result has errorCode", () => {
    const result: SendResult = { errorCode: "GMAIL_SEND_FAILED" };
    expect(isSendSuccess(result)).toBe(false);
  });
});
