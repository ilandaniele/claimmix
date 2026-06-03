/**
 * Unit tests for the EmailProvider factory (getEmailProvider / setEmailProvider / resetEmailProvider).
 *
 * Tests that:
 * - getEmailProvider() returns an instance satisfying the EmailProvider interface.
 * - Repeated calls return the same singleton.
 * - setEmailProvider() overrides the singleton.
 * - resetEmailProvider() clears the singleton so the next call creates a new one.
 * - isSendSuccess() type guard works correctly.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { EmailProvider, SendEmailOptions, SendResult } from "../../src/server/email/provider";
import { isSendSuccess } from "../../src/server/email/provider";

// Mock postmark so PostmarkSender can be constructed without a real server token.
vi.mock("postmark", () => ({
  ServerClient: vi.fn().mockImplementation(() => ({
    sendEmail: vi.fn().mockResolvedValue({ MessageID: "mock-id" }),
  })),
}));

const {
  getEmailProvider,
  setEmailProvider,
  resetEmailProvider,
} = await import("../../src/server/email/postmark/index");

// A simple mock provider for DI tests.
function makeMockProvider(name: "postmark" = "postmark"): EmailProvider {
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

  it("returns an EmailProvider instance with name='postmark'", () => {
    process.env.POSTMARK_SERVER_TOKEN = "test-token";
    process.env.POSTMARK_FROM_ADDRESS = "test@example.com";

    const provider = getEmailProvider();

    expect(provider).toBeDefined();
    expect(provider.name).toBe("postmark");
    expect(typeof provider.send).toBe("function");

    delete process.env.POSTMARK_SERVER_TOKEN;
    delete process.env.POSTMARK_FROM_ADDRESS;
  });

  it("returns the same singleton on repeated calls", () => {
    process.env.POSTMARK_SERVER_TOKEN = "test-token";

    const a = getEmailProvider();
    const b = getEmailProvider();

    expect(a).toBe(b);

    delete process.env.POSTMARK_SERVER_TOKEN;
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
});

describe("resetEmailProvider()", () => {
  it("clears the singleton so next call creates a new instance", () => {
    process.env.POSTMARK_SERVER_TOKEN = "test-token";

    const first = getEmailProvider();
    resetEmailProvider();
    const second = getEmailProvider();

    expect(first).not.toBe(second);

    resetEmailProvider();
    delete process.env.POSTMARK_SERVER_TOKEN;
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
    const result: SendResult = { errorCode: "POSTMARK_SEND_FAILED" };
    expect(isSendSuccess(result)).toBe(false);
  });
});
