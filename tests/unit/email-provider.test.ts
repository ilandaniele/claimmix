/**
 * Unit tests for isSendSuccess() (src/server/email/provider.ts).
 */

import { describe, it, expect } from "vitest";
import type { SendResult } from "../../src/server/email/provider";
import { isSendSuccess } from "../../src/server/email/provider";

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
