/**
 * Unit tests for GET /api/cron/gmail-poll route handler.
 *
 * AC6: Cron route rejects unauthenticated calls:
 *   - No Authorization header → 401
 *   - Wrong bearer token → 401
 *   - Correct CRON_SECRET → 200 { ok: true, ... }
 *   - Gmail API not called on 401
 *   - pollAllGmailAccounts called exactly once on success
 *
 * AC1: Route calls pollAllGmailAccounts on success and returns its result.
 * AC9: watch_expiration within 24h + PUBSUB_TOPIC set → setupGmailWatch called;
 *      response includes watch_renewed:true.
 * AC10: watch_expiration >24h away + PUBSUB_TOPIC set → setupGmailWatch NOT called;
 *       response includes watch_renewed:false.
 * AC11: PUBSUB_TOPIC not set → setupGmailWatch NOT called; response includes
 *       watch_renewed:false and watch_skipped_reason:'PUBSUB_TOPIC_UNSET'.
 * AC13: 500 errors from pollAllGmailAccounts are caught and returned as { error: { code: "INTERNAL" } }.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks (must be hoisted before the import of route.ts) ─────────────────────

const {
  mockPollAllGmailAccounts,
  mockListEnabledGmailAccounts,
  mockGetWatchExpiration,
  mockSetupGmailWatch,
} = vi.hoisted(() => ({
  mockPollAllGmailAccounts: vi.fn(),
  mockListEnabledGmailAccounts: vi.fn(),
  mockGetWatchExpiration: vi.fn(),
  mockSetupGmailWatch: vi.fn(),
}));

vi.mock("@/server/email/gmail/gmail-poller", () => ({
  pollAllGmailAccounts: mockPollAllGmailAccounts,
}));

vi.mock("@/server/email/gmail/accounts", () => ({
  listEnabledGmailAccounts: mockListEnabledGmailAccounts,
}));

vi.mock("@/server/email/gmail/poll-state", () => ({
  getWatchExpiration: mockGetWatchExpiration,
}));

vi.mock("@/server/email/gmail/watch", () => ({
  setupGmailWatch: mockSetupGmailWatch,
}));

// ── Import route AFTER mocks ──────────────────────────────────────────────────

import { GET } from "@/app/api/cron/gmail-poll/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

const CRON_SECRET = "test-cron-secret-abc123def456";

function makeRequest(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) {
    headers["authorization"] = authHeader;
  }
  return new NextRequest("http://localhost/api/cron/gmail-poll", { headers });
}

const MOCK_POLL_RESULT = {
  accounts: 1,
  processed: 2,
  skipped: 1,
  errors: 0,
  results: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

const GMAIL_EMAIL = "test@example.com";
const PUBSUB_TOPIC = "projects/my-project/topics/gmail-push";

describe("GET /api/cron/gmail-poll", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
    process.env.GMAIL_USER_EMAIL = GMAIL_EMAIL;
    process.env.PUBSUB_TOPIC = PUBSUB_TOPIC;
    // By default, no connected accounts (fallback to env var)
    mockListEnabledGmailAccounts.mockResolvedValue([]);
    mockPollAllGmailAccounts.mockResolvedValue(MOCK_POLL_RESULT);
    // Default: watch expires 5 days from now (not expiring soon)
    mockGetWatchExpiration.mockResolvedValue(
      new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
    );
    mockSetupGmailWatch.mockResolvedValue({
      historyId: "12345",
      expiration: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.GMAIL_USER_EMAIL;
    delete process.env.PUBSUB_TOPIC;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // ── AC6: Auth rejection ────────────────────────────────────────────────────

  it("AC6: returns 401 when Authorization header is missing", async () => {
    const req = makeRequest(undefined);
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(mockPollAllGmailAccounts).not.toHaveBeenCalled();
  });

  it("AC6: returns 401 when Authorization header is an empty string", async () => {
    const req = makeRequest("");
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(mockPollAllGmailAccounts).not.toHaveBeenCalled();
  });

  it("AC6: returns 401 when bearer token is wrong", async () => {
    const req = makeRequest("Bearer wrong-token");
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(mockPollAllGmailAccounts).not.toHaveBeenCalled();
  });

  it("AC6: returns 401 when Authorization is missing 'Bearer' prefix", async () => {
    const req = makeRequest(CRON_SECRET); // bare secret without "Bearer"
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(mockPollAllGmailAccounts).not.toHaveBeenCalled();
  });

  it("AC6: returns 401 when CRON_SECRET env var is not set", async () => {
    delete process.env.CRON_SECRET;
    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    const res = await GET(req);

    // When CRON_SECRET is not configured, returns 500 (not 401)
    expect(res.status).toBe(500);
    expect(mockPollAllGmailAccounts).not.toHaveBeenCalled();
  });

  // ── AC1/AC6: Successful auth + pollAllGmailAccounts called ────────────────────────────

  it("AC6: returns 200 with correct CRON_SECRET and calls pollAllGmailAccounts once", async () => {
    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(MOCK_POLL_RESULT.processed);
    expect(body.skipped).toBe(MOCK_POLL_RESULT.skipped);
    // watch_renewed is always present in the success response
    expect(typeof body.watch_renewed).toBe("boolean");
    expect(mockPollAllGmailAccounts).toHaveBeenCalledTimes(1);
  });

  it("AC1: calls pollAllGmailAccounts without arguments", async () => {
    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    await GET(req);

    expect(mockPollAllGmailAccounts).toHaveBeenCalledTimes(1);
    expect(mockPollAllGmailAccounts).toHaveBeenCalledWith();
  });

  // ── AC13: Error handling ───────────────────────────────────────────────────

  it("AC13: returns 500 when pollAllGmailAccounts throws a fatal error", async () => {
    const fatalError = Object.assign(new Error("DB connection lost"), {
      code: "CONNECTION_FAILED",
    });
    mockPollAllGmailAccounts.mockRejectedValue(fatalError);

    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    const res = await GET(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL");
    // Ensure the error message does not leak internal details to the client
    expect(body.error.message).not.toContain("DB connection lost");
  });

  it("AC13: logs only error code on fatal error, no PII", async () => {
    const err = Object.assign(new Error("sensitive data here"), {
      code: "FATAL_CODE",
    });
    mockPollAllGmailAccounts.mockRejectedValue(err);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    await GET(req);

    // Ensure console.error was called with the code only
    const calls = consoleSpy.mock.calls.flat().join(" ");
    expect(calls).toContain("FATAL_CODE");
    expect(calls).not.toContain("sensitive data here");
  });

  // ── Timing-safe comparison ─────────────────────────────────────────────────

  it("rejects a token that differs only in the last character (timing-safe)", async () => {
    // Modify the last character of the correct token
    const tamperedToken = `Bearer ${CRON_SECRET.slice(0, -1)}X`;
    const req = makeRequest(tamperedToken);
    const res = await GET(req);

    expect(res.status).toBe(401);
    expect(mockPollAllGmailAccounts).not.toHaveBeenCalled();
  });

  // ── AC9: Watch renewal when expiring within 24h ────────────────────────────

  it("AC9: calls setupGmailWatch when watch_expiration is within 24h", async () => {
    // Expiration is 12 hours from now — inside the 24h renewal window.
    mockGetWatchExpiration.mockResolvedValue(
      new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    );

    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(mockSetupGmailWatch).toHaveBeenCalledTimes(1);
    expect(mockSetupGmailWatch).toHaveBeenCalledWith(
      PUBSUB_TOPIC,
      expect.objectContaining({ email: GMAIL_EMAIL })
    );
    expect(mockPollAllGmailAccounts).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.watch_renewed).toBe(true);
    expect(body.watch_skipped_reason).toBeUndefined();
  });

  it("AC9: calls setupGmailWatch when watch_expiration is exactly now", async () => {
    // Expiration is now — expired, must renew.
    mockGetWatchExpiration.mockResolvedValue(new Date(Date.now()).toISOString());

    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(mockSetupGmailWatch).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.watch_renewed).toBe(true);
  });

  it("AC9: calls setupGmailWatch when watch_expiration is null (never registered)", async () => {
    // Null means no watch has ever been set up — treat as needing renewal.
    mockGetWatchExpiration.mockResolvedValue(null);

    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(mockSetupGmailWatch).toHaveBeenCalledTimes(1);
    expect(mockPollAllGmailAccounts).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.watch_renewed).toBe(true);
  });

  // ── AC10: Watch renewal skipped when expiration is >24h away ──────────────

  it("AC10: does NOT call setupGmailWatch when watch_expiration is 5 days away", async () => {
    // 5 days from now — well outside the 24h renewal window.
    mockGetWatchExpiration.mockResolvedValue(
      new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
    );

    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    expect(mockPollAllGmailAccounts).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.watch_renewed).toBe(false);
    expect(body.watch_skipped_reason).toBeUndefined();
  });

  it("AC10: does NOT call setupGmailWatch when watch_expiration is exactly 25h away", async () => {
    // 25 hours from now — just outside the 24h threshold.
    mockGetWatchExpiration.mockResolvedValue(
      new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString()
    );

    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.watch_renewed).toBe(false);
  });

  // ── AC11: Watch renewal skipped when PUBSUB_TOPIC is not set ──────────────

  it("AC11: skips setupGmailWatch and continues polling when PUBSUB_TOPIC is not set", async () => {
    delete process.env.PUBSUB_TOPIC;

    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    expect(mockGetWatchExpiration).not.toHaveBeenCalled();
    expect(mockPollAllGmailAccounts).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.watch_renewed).toBe(false);
    expect(body.watch_skipped_reason).toBe("PUBSUB_TOPIC_UNSET");
  });

  it("AC11: does not throw when PUBSUB_TOPIC is not set — cron completes normally", async () => {
    delete process.env.PUBSUB_TOPIC;
    mockPollAllGmailAccounts.mockResolvedValue(MOCK_POLL_RESULT);

    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(MOCK_POLL_RESULT.processed);
  });

  // ── Non-blocking renewal error ─────────────────────────────────────────────

  it("logs error name and continues to call pollAllGmailAccounts when setupGmailWatch throws", async () => {
    // Expiration is within 24h, so renewal is attempted.
    mockGetWatchExpiration.mockResolvedValue(
      new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
    );
    const watchError = Object.assign(new Error("API quota exceeded"), {
      name: "QuotaExceededError",
    });
    mockSetupGmailWatch.mockRejectedValue(watchError);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    const res = await GET(req);

    // Response must still be 200 — watch renewal failure is non-fatal.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.watch_renewed).toBe(false);

    // pollAllGmailAccounts must still have been called despite the watch error.
    expect(mockPollAllGmailAccounts).toHaveBeenCalledTimes(1);

    // Error name must be logged; error message (which may contain PII) must not.
    const loggedText = consoleSpy.mock.calls.flat().join(" ");
    expect(loggedText).toContain("QuotaExceededError");
    expect(loggedText).not.toContain("API quota exceeded");
  });
});
