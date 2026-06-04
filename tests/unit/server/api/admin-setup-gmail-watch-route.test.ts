/**
 * Unit tests for POST /api/admin/setup-gmail-watch route handler.
 *
 * AC12: No auth header (or wrong credentials) → 401, setupGmailWatch NOT called.
 * AC13: X-Internal-Worker: true → setupGmailWatch called, 200 with {historyId, expiration, message}.
 * AC14: Authorization: Bearer <CRON_SECRET> → setupGmailWatch called, 200.
 * AC15: PUBSUB_TOPIC not set → 500 with code PUBSUB_TOPIC_MISSING, setupGmailWatch NOT called.
 *
 * Strategy:
 * - Mock setupGmailWatch via vi.hoisted so it is hoisted before the route import.
 * - Vary CRON_SECRET and PUBSUB_TOPIC in beforeEach / per-test to cover all branches.
 * - All tests verify response status, body shape, and whether setupGmailWatch was called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks (hoisted before any module import) ──────────────────────────────────

const { mockSetupGmailWatch } = vi.hoisted(() => ({
  mockSetupGmailWatch: vi.fn(),
}));

vi.mock("@/server/email/gmail/watch", () => ({
  setupGmailWatch: mockSetupGmailWatch,
}));

// ── Import route AFTER mocks ──────────────────────────────────────────────────

import { POST } from "@/app/api/admin/setup-gmail-watch/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

const CRON_SECRET = "test-cron-secret-xyz789";
const PUBSUB_TOPIC = "projects/claimmix/topics/gmail-push";

const MOCK_WATCH_RESULT = {
  historyId: "123456",
  expiration: new Date(1750000000000).toISOString(),
};

function makeRequest(options: {
  internalWorker?: boolean;
  authHeader?: string;
} = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (options.internalWorker) {
    headers["x-internal-worker"] = "true";
  }
  if (options.authHeader !== undefined) {
    headers["authorization"] = options.authHeader;
  }
  return new NextRequest("http://localhost/api/admin/setup-gmail-watch", {
    method: "POST",
    headers,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/admin/setup-gmail-watch", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
    process.env.PUBSUB_TOPIC = PUBSUB_TOPIC;
    mockSetupGmailWatch.mockResolvedValue(MOCK_WATCH_RESULT);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.PUBSUB_TOPIC;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // ── AC12: Unauthorized requests ────────────────────────────────────────────

  describe("AC12 — no auth → 401", () => {
    it("returns 401 when no auth header is present", async () => {
      const req = makeRequest();
      const res = await POST(req);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    });

    it("returns 401 when bearer token is wrong", async () => {
      const req = makeRequest({ authHeader: "Bearer wrong-token" });
      const res = await POST(req);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    });

    it("returns 401 when Authorization header lacks Bearer prefix", async () => {
      const req = makeRequest({ authHeader: CRON_SECRET });
      const res = await POST(req);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    });

    it("returns 401 when x-internal-worker header is 'false'", async () => {
      const headers: Record<string, string> = { "x-internal-worker": "false" };
      const req = new NextRequest("http://localhost/api/admin/setup-gmail-watch", {
        method: "POST",
        headers,
      });
      const res = await POST(req);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    });
  });

  // ── AC13: X-Internal-Worker: true ─────────────────────────────────────────

  describe("AC13 — X-Internal-Worker: true → 200 with watch data", () => {
    it("calls setupGmailWatch and returns historyId, expiration, message", async () => {
      const req = makeRequest({ internalWorker: true });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.historyId).toBe(MOCK_WATCH_RESULT.historyId);
      expect(body.data.expiration).toBe(MOCK_WATCH_RESULT.expiration);
      expect(body.data.message).toBe("Gmail watch configured successfully.");
      expect(mockSetupGmailWatch).toHaveBeenCalledOnce();
      expect(mockSetupGmailWatch).toHaveBeenCalledWith(PUBSUB_TOPIC);
    });

    it("passes PUBSUB_TOPIC env var to setupGmailWatch", async () => {
      const customTopic = "projects/other/topics/custom-topic";
      process.env.PUBSUB_TOPIC = customTopic;

      const req = makeRequest({ internalWorker: true });
      await POST(req);

      expect(mockSetupGmailWatch).toHaveBeenCalledWith(customTopic);
    });
  });

  // ── AC14: Bearer CRON_SECRET ───────────────────────────────────────────────

  describe("AC14 — Authorization: Bearer <CRON_SECRET> → 200", () => {
    it("calls setupGmailWatch and returns 200 when using CRON_SECRET bearer token", async () => {
      const req = makeRequest({ authHeader: `Bearer ${CRON_SECRET}` });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.historyId).toBe(MOCK_WATCH_RESULT.historyId);
      expect(body.data.expiration).toBe(MOCK_WATCH_RESULT.expiration);
      expect(body.data.message).toBe("Gmail watch configured successfully.");
      expect(mockSetupGmailWatch).toHaveBeenCalledOnce();
    });

    it("returns 401 when CRON_SECRET env var is not set and bearer token is used", async () => {
      delete process.env.CRON_SECRET;
      const req = makeRequest({ authHeader: `Bearer ${CRON_SECRET}` });
      const res = await POST(req);

      // CRON_SECRET not configured means bearer auth path is skipped → 401
      expect(res.status).toBe(401);
      expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    });
  });

  // ── AC15: Missing PUBSUB_TOPIC ─────────────────────────────────────────────

  describe("AC15 — PUBSUB_TOPIC missing → 500 PUBSUB_TOPIC_MISSING", () => {
    it("returns 500 with PUBSUB_TOPIC_MISSING when env var is not set", async () => {
      delete process.env.PUBSUB_TOPIC;
      const req = makeRequest({ internalWorker: true });
      const res = await POST(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe("PUBSUB_TOPIC_MISSING");
      expect(body.error.message).toMatch(/PUBSUB_TOPIC/);
      expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    });

    it("does not call setupGmailWatch when PUBSUB_TOPIC is missing", async () => {
      delete process.env.PUBSUB_TOPIC;
      const req = makeRequest({ authHeader: `Bearer ${CRON_SECRET}` });
      await POST(req);

      expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    });

    it("returns 500 PUBSUB_TOPIC_MISSING even with valid X-Internal-Worker header", async () => {
      delete process.env.PUBSUB_TOPIC;
      const req = makeRequest({ internalWorker: true });
      const res = await POST(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe("PUBSUB_TOPIC_MISSING");
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  describe("error handling — setupGmailWatch throws", () => {
    it("returns 500 WATCH_SETUP_FAILED when setupGmailWatch throws", async () => {
      const err = new Error("Gmail API quota exceeded");
      mockSetupGmailWatch.mockRejectedValue(err);

      const req = makeRequest({ internalWorker: true });
      const res = await POST(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe("WATCH_SETUP_FAILED");
      expect(body.error.message).toBe("Gmail API quota exceeded");
    });

    it("logs only the error name, not the full message", async () => {
      const err = Object.assign(new Error("sensitive internal detail"), {
        name: "GmailApiError",
      });
      mockSetupGmailWatch.mockRejectedValue(err);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const req = makeRequest({ internalWorker: true });
      await POST(req);

      const loggedOutput = consoleSpy.mock.calls.flat().join(" ");
      expect(loggedOutput).toContain("GmailApiError");
      expect(loggedOutput).not.toContain("sensitive internal detail");
    });
  });
});
