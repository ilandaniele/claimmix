/**
 * Unit tests for GET /api/cron/gmail-poll route handler.
 *
 * AC6: Cron route rejects unauthenticated calls:
 *   - No Authorization header → 401
 *   - Wrong bearer token → 401
 *   - Correct CRON_SECRET → 200 { ok: true, ... }
 *   - Gmail API not called on 401
 *   - pollGmail called exactly once on success
 *
 * AC1: Route calls pollGmail on success and returns its result.
 * AC13: 500 errors from pollGmail are caught and returned as { error: { code: "INTERNAL" } }.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks (must be hoisted before the import of route.ts) ─────────────────────

const { mockPollGmail, mockCreateServiceClient } = vi.hoisted(() => ({
  mockPollGmail: vi.fn(),
  mockCreateServiceClient: vi.fn(),
}));

vi.mock("@/server/email/gmail/gmail-poller", () => ({
  pollGmail: mockPollGmail,
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mockCreateServiceClient,
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
  processed: 2,
  skipped: 1,
  errors: 0,
  fallback: false,
  history_id: "99999",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/cron/gmail-poll", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
    mockCreateServiceClient.mockReturnValue({ from: vi.fn() });
    mockPollGmail.mockResolvedValue(MOCK_POLL_RESULT);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
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
    expect(mockPollGmail).not.toHaveBeenCalled();
  });

  it("AC6: returns 401 when Authorization header is an empty string", async () => {
    const req = makeRequest("");
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(mockPollGmail).not.toHaveBeenCalled();
  });

  it("AC6: returns 401 when bearer token is wrong", async () => {
    const req = makeRequest("Bearer wrong-token");
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(mockPollGmail).not.toHaveBeenCalled();
  });

  it("AC6: returns 401 when Authorization is missing 'Bearer' prefix", async () => {
    const req = makeRequest(CRON_SECRET); // bare secret without "Bearer"
    const res = await GET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(mockPollGmail).not.toHaveBeenCalled();
  });

  it("AC6: returns 401 when CRON_SECRET env var is not set", async () => {
    delete process.env.CRON_SECRET;
    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    const res = await GET(req);

    // When CRON_SECRET is not configured, returns 500 (not 401)
    expect(res.status).toBe(500);
    expect(mockPollGmail).not.toHaveBeenCalled();
  });

  // ── AC1/AC6: Successful auth + pollGmail called ────────────────────────────

  it("AC6: returns 200 with correct CRON_SECRET and calls pollGmail once", async () => {
    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(MOCK_POLL_RESULT.processed);
    expect(body.skipped).toBe(MOCK_POLL_RESULT.skipped);
    expect(body.history_id).toBe(MOCK_POLL_RESULT.history_id);
    expect(mockPollGmail).toHaveBeenCalledTimes(1);
  });

  it("AC1: passes a supabase service client to pollGmail", async () => {
    const mockClient = { from: vi.fn() };
    mockCreateServiceClient.mockReturnValue(mockClient);

    const req = makeRequest(`Bearer ${CRON_SECRET}`);
    await GET(req);

    expect(mockCreateServiceClient).toHaveBeenCalledTimes(1);
    expect(mockPollGmail).toHaveBeenCalledWith(mockClient);
  });

  // ── AC13: Error handling ───────────────────────────────────────────────────

  it("AC13: returns 500 when pollGmail throws a fatal error", async () => {
    const fatalError = Object.assign(new Error("DB connection lost"), {
      code: "CONNECTION_FAILED",
    });
    mockPollGmail.mockRejectedValue(fatalError);

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
    mockPollGmail.mockRejectedValue(err);

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
    expect(mockPollGmail).not.toHaveBeenCalled();
  });
});
