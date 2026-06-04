/**
 * Unit tests for POST /api/webhooks/gmail (src/app/api/webhooks/gmail/route.ts).
 *
 * AC4: PUBSUB_AUDIENCE NOT set → skip OIDC verify, call pollGmail, return 200 { ok: true }
 * AC5: PUBSUB_AUDIENCE set + no Authorization header → 401 { error: { code: "MISSING_TOKEN" } }
 * AC6: PUBSUB_AUDIENCE set + Bearer token that fails verifyIdToken → 401 { error: { code: "INVALID_TOKEN" } }
 * AC7: PUBSUB_AUDIENCE unset + pollGmail throws → 200 { ok: true, error: <error name> }
 * AC8: Missing message.data → 400 { error: { code: "INVALID_ENVELOPE" } }
 *
 * Strategy:
 * - vi.mock "google-auth-library" to control OAuth2Client.verifyIdToken.
 * - vi.mock "@/server/email/gmail/gmail-poller" to control pollGmail.
 * - vi.mock "@/lib/supabase/service" to avoid real Supabase calls.
 * - Each test imports the route handler fresh via dynamic import in the
 *   beforeEach/describe scope so module-level singletons (_oidcClient,
 *   _warnedSkipVerify) reset between env var changes.
 * - Helper buildRequest() constructs a minimal NextRequest for the handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoist mock factories ───────────────────────────────────────────────────────

const { mockVerifyIdToken, MockOAuth2Client, mockPollGmail, mockCreateServiceClient } =
  vi.hoisted(() => {
    const mockVerifyIdToken = vi.fn();
    const MockOAuth2Client = vi.fn(function (this: unknown) {
      (this as Record<string, unknown>).verifyIdToken = mockVerifyIdToken;
    });
    const mockPollGmail = vi.fn();
    const mockCreateServiceClient = vi.fn(() => ({ _isMock: true }));
    return { mockVerifyIdToken, MockOAuth2Client, mockPollGmail, mockCreateServiceClient };
  });

// ── Module mocks (declared before any import that triggers them) ──────────────

vi.mock("google-auth-library", () => ({
  OAuth2Client: MockOAuth2Client,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/server/email/gmail/gmail-poller", () => ({
  pollGmail: mockPollGmail,
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mockCreateServiceClient,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal Pub/Sub envelope with properly base64-encoded message.data.
 */
function buildEnvelope(
  emailAddress = "test@example.com",
  historyId = "999"
): Record<string, unknown> {
  const data = Buffer.from(JSON.stringify({ emailAddress, historyId })).toString(
    "base64"
  );
  return {
    message: {
      data,
      messageId: "msg-001",
      publishTime: "2026-06-04T18:00:00Z",
    },
    subscription: "projects/p/subscriptions/s",
  };
}

/**
 * Build a NextRequest POST with optional headers and body.
 */
function buildRequest(
  body: unknown,
  headers: Record<string, string> = {}
): NextRequest {
  const url = "http://localhost:3000/api/webhooks/gmail";
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/webhooks/gmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default env state.
    delete process.env.PUBSUB_AUDIENCE;
    // Default: pollGmail resolves successfully with a result object.
    mockPollGmail.mockResolvedValue({
      processed: 1,
      skipped: 0,
      errors: 0,
      fallback: false,
      history_id: "1000",
    });
  });

  afterEach(() => {
    delete process.env.PUBSUB_AUDIENCE;
    // Clear module cache so next describe block gets a fresh module with
    // reset singleton state (_oidcClient, _warnedSkipVerify).
    vi.resetModules();
  });

  // ── AC4: No PUBSUB_AUDIENCE → skip verify, call pollGmail, 200 ───────────────

  describe("AC4: PUBSUB_AUDIENCE NOT set (skip-verify mode)", () => {
    it("AC4: pollGmail is called exactly once and response is 200 { ok: true }", async () => {
      // PUBSUB_AUDIENCE deliberately not set.
      const { POST } = await import("@/app/api/webhooks/gmail/route");
      const req = buildRequest(buildEnvelope());

      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockPollGmail).toHaveBeenCalledTimes(1);
      // verifyIdToken must NOT be called when audience is unset.
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
    });

    it("AC4: pollGmail receives the Supabase service client", async () => {
      const { POST } = await import("@/app/api/webhooks/gmail/route");
      const req = buildRequest(buildEnvelope());

      await POST(req);

      expect(mockCreateServiceClient).toHaveBeenCalledTimes(1);
      const [supabaseArg] = mockPollGmail.mock.calls[0];
      expect(supabaseArg).toEqual({ _isMock: true });
    });
  });

  // ── AC5: PUBSUB_AUDIENCE set + no auth header → 401 MISSING_TOKEN ─────────────

  describe("AC5: PUBSUB_AUDIENCE set, no Authorization header", () => {
    it("AC5: returns 401 with code MISSING_TOKEN", async () => {
      process.env.PUBSUB_AUDIENCE = "https://app.test/api/webhooks/gmail";
      const { POST } = await import("@/app/api/webhooks/gmail/route");
      const req = buildRequest(buildEnvelope()); // no Authorization header

      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.error.code).toBe("MISSING_TOKEN");
    });

    it("AC5: pollGmail is NOT called when token is missing", async () => {
      process.env.PUBSUB_AUDIENCE = "https://app.test/api/webhooks/gmail";
      const { POST } = await import("@/app/api/webhooks/gmail/route");
      const req = buildRequest(buildEnvelope());

      await POST(req);

      expect(mockPollGmail).not.toHaveBeenCalled();
    });
  });

  // ── AC6: PUBSUB_AUDIENCE set + invalid/mismatched OIDC token → 401 INVALID_TOKEN

  describe("AC6: PUBSUB_AUDIENCE set, verifyIdToken throws (invalid/mismatched token)", () => {
    it("AC6: returns 401 with code INVALID_TOKEN when verifyIdToken throws", async () => {
      process.env.PUBSUB_AUDIENCE = "https://app.test/api/webhooks/gmail";
      // Simulate audience mismatch or signature failure.
      mockVerifyIdToken.mockRejectedValue(
        new Error("Token has wrong audience.")
      );
      const { POST } = await import("@/app/api/webhooks/gmail/route");
      const req = buildRequest(buildEnvelope(), {
        Authorization: "Bearer invalid.token.here",
      });

      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.error.code).toBe("INVALID_TOKEN");
    });

    it("AC6: verifyIdToken is called with the bearer token and correct audience", async () => {
      process.env.PUBSUB_AUDIENCE = "https://app.test/api/webhooks/gmail";
      mockVerifyIdToken.mockRejectedValue(new Error("Token has wrong audience."));
      const { POST } = await import("@/app/api/webhooks/gmail/route");
      const bearerToken = "a.valid.looking.jwt";
      const req = buildRequest(buildEnvelope(), {
        Authorization: `Bearer ${bearerToken}`,
      });

      await POST(req);

      expect(mockVerifyIdToken).toHaveBeenCalledWith({
        idToken: bearerToken,
        audience: "https://app.test/api/webhooks/gmail",
      });
    });

    it("AC6: pollGmail is NOT called when token verification fails", async () => {
      process.env.PUBSUB_AUDIENCE = "https://app.test/api/webhooks/gmail";
      mockVerifyIdToken.mockRejectedValue(new Error("Token has wrong audience."));
      const { POST } = await import("@/app/api/webhooks/gmail/route");
      const req = buildRequest(buildEnvelope(), {
        Authorization: "Bearer bad.token",
      });

      await POST(req);

      expect(mockPollGmail).not.toHaveBeenCalled();
    });

    it("AC6: response body does NOT contain any token contents", async () => {
      process.env.PUBSUB_AUDIENCE = "https://app.test/api/webhooks/gmail";
      mockVerifyIdToken.mockRejectedValue(new Error("Token has wrong audience."));
      const { POST } = await import("@/app/api/webhooks/gmail/route");
      const req = buildRequest(buildEnvelope(), {
        Authorization: "Bearer secret.token.value",
      });

      const res = await POST(req);
      const body = JSON.stringify(await res.json());

      // Response must not echo the token or its contents.
      expect(body).not.toContain("secret.token.value");
      expect(body).not.toContain("Token has wrong audience");
    });

    it("AC6: valid token passes verification and calls pollGmail", async () => {
      process.env.PUBSUB_AUDIENCE = "https://app.test/api/webhooks/gmail";
      // verifyIdToken resolves — token is valid.
      mockVerifyIdToken.mockResolvedValue({ payload: { aud: "https://app.test/api/webhooks/gmail" } });
      const { POST } = await import("@/app/api/webhooks/gmail/route");
      const req = buildRequest(buildEnvelope(), {
        Authorization: "Bearer valid.google.signed.jwt",
      });

      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(mockPollGmail).toHaveBeenCalledTimes(1);
    });
  });

  // ── AC7: pollGmail throws → 200 { ok: true, error: <name> } ─────────────────

  describe("AC7: pollGmail throws — ACK with 200 anyway", () => {
    it("AC7: returns 200 { ok: true, error: <name> } when pollGmail rejects", async () => {
      // PUBSUB_AUDIENCE not set — skip verify so we reach pollGmail.
      const supabaseErr = new Error("supabase_unreachable");
      supabaseErr.name = "supabase_unreachable";
      mockPollGmail.mockRejectedValue(supabaseErr);

      const { POST } = await import("@/app/api/webhooks/gmail/route");
      const req = buildRequest(buildEnvelope());

      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.error).toBe("supabase_unreachable");
    });

    it("AC7: response body does NOT contain stack trace or PII", async () => {
      const err = new Error("supabase_unreachable");
      err.name = "supabase_unreachable";
      mockPollGmail.mockRejectedValue(err);

      const { POST } = await import("@/app/api/webhooks/gmail/route");
      const req = buildRequest(buildEnvelope("user@example.com", "777"));

      const res = await POST(req);
      const body = JSON.stringify(await res.json());

      // No stack trace, no email address, no historyId in response.
      expect(body).not.toContain("stack");
      expect(body).not.toContain("user@example.com");
      expect(body).not.toContain("777");
    });
  });

  // ── AC8: Missing message.data → 400 INVALID_ENVELOPE ─────────────────────────

  describe("AC8: malformed Pub/Sub envelope", () => {
    it("AC8: returns 400 INVALID_ENVELOPE when message.data is absent", async () => {
      const { POST } = await import("@/app/api/webhooks/gmail/route");
      const req = buildRequest({ foo: "bar" }); // no message.data

      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe("INVALID_ENVELOPE");
    });

    it("AC8: returns 400 when message key is entirely absent", async () => {
      const { POST } = await import("@/app/api/webhooks/gmail/route");
      const req = buildRequest({ subscription: "projects/p/subscriptions/s" });

      const res = await POST(req);

      expect(res.status).toBe(400);
    });

    it("AC8: returns 400 when message exists but data is missing", async () => {
      const { POST } = await import("@/app/api/webhooks/gmail/route");
      const req = buildRequest({
        message: { messageId: "abc", publishTime: "2026-06-04T18:00:00Z" },
        subscription: "projects/p/subscriptions/s",
      });

      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe("INVALID_ENVELOPE");
    });

    it("AC8: pollGmail is NOT called for malformed envelopes", async () => {
      const { POST } = await import("@/app/api/webhooks/gmail/route");
      const req = buildRequest({ foo: "bar" });

      await POST(req);

      expect(mockPollGmail).not.toHaveBeenCalled();
    });
  });
});
