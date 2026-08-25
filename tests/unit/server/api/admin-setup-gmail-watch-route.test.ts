/**
 * Unit tests for POST /api/admin/setup-gmail-watch route handler.
 *
 * AC12: No auth header (or wrong credentials) → 401, setupGmailWatch NOT called.
 * AC13: credencial interna (Bearer CRON_SECRET) → setupGmailWatch, 200 con {historyId, expiration, message}.
 * AC14: Authorization: Bearer <CRON_SECRET> → setupGmailWatch called, 200.
 * AC15: PUBSUB_TOPIC not set → 500 with code PUBSUB_NOT_CONFIGURED, setupGmailWatch NOT called.
 *
 * Strategy:
 * - Mock setupGmailWatch via vi.hoisted so it is hoisted before the route import.
 * - Vary CRON_SECRET and PUBSUB_TOPIC in beforeEach / per-test to cover all branches.
 * - All tests verify response status, body shape, and whether setupGmailWatch was called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks (hoisted before any module import) ──────────────────────────────────

const { mockSetupGmailWatch, mockListEnabledGmailAccounts } = vi.hoisted(() => ({
  mockSetupGmailWatch: vi.fn(),
  mockListEnabledGmailAccounts: vi.fn(),
}));

vi.mock("@/server/email/gmail/watch", () => ({
  setupGmailWatch: mockSetupGmailWatch,
}));

// La ruta ya no saca la casilla de GMAIL_USER_EMAIL sino de la base, que es
// donde vive desde que se conectan por pantalla. Ver el caso de abajo.
vi.mock("@/server/email/gmail/accounts", () => ({
  listEnabledGmailAccounts: mockListEnabledGmailAccounts,
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

const MOCK_ACCOUNT = {
  id: "acc-1",
  tenant_id: "tenant-1",
  email: "casilla@example.com",
  refreshToken: "refresh-token-de-prueba",
  enabled: true,
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
    mockListEnabledGmailAccounts.mockResolvedValue([MOCK_ACCOUNT]);
    delete process.env.GMAIL_USER_EMAIL;
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

    it("el header X-Internal-Worker: true YA NO autoriza (era el bypass)", async () => {
      // Un header lo manda cualquiera; no es una credencial. Este test existe
      // para que el bypass no vuelva. Ver internal-auth.ts.
      const req = makeRequest({ internalWorker: true });
      const res = await POST(req);
      expect(res.status).toBe(401);
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

  // ── AC13: la credencial interna (CRON_SECRET) → 200 ──────────────────────

  describe("AC13 — credencial interna (Bearer CRON_SECRET) → 200 with watch data", () => {
    it("calls setupGmailWatch and returns historyId, expiration, message", async () => {
      const req = makeRequest({ authHeader: `Bearer ${CRON_SECRET}` });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.registered).toHaveLength(1);
      expect(body.registered[0].historyId).toBe(MOCK_WATCH_RESULT.historyId);
      expect(body.registered[0].expiration).toBe(MOCK_WATCH_RESULT.expiration);
      expect(body.registered[0].email).toBe(MOCK_ACCOUNT.email);
      expect(body.message).toBe("watch setup OK");
      expect(mockSetupGmailWatch).toHaveBeenCalledOnce();
      expect(mockSetupGmailWatch).toHaveBeenCalledWith(PUBSUB_TOPIC, {
        email: MOCK_ACCOUNT.email,
        refreshToken: MOCK_ACCOUNT.refreshToken,
      });
    });

    it("passes PUBSUB_TOPIC env var to setupGmailWatch", async () => {
      const customTopic = "projects/other/topics/custom-topic";
      process.env.PUBSUB_TOPIC = customTopic;

      const req = makeRequest({ authHeader: `Bearer ${CRON_SECRET}` });
      await POST(req);

      expect(mockSetupGmailWatch).toHaveBeenCalledWith(
        customTopic,
        expect.objectContaining({ email: MOCK_ACCOUNT.email })
      );
    });

    // El defecto que trajo esto: reconectar la casilla dejaba el push muerto y
    // esta ruta —la única forma de revivirlo a mano— devolvía 500, porque
    // buscaba la casilla en una variable de entorno que ya nadie carga.
    it("registra el aviso para la casilla de la base, no para GMAIL_USER_EMAIL", async () => {
      process.env.GMAIL_USER_EMAIL = "vieja-y-muerta@example.com";

      const req = makeRequest({ authHeader: `Bearer ${CRON_SECRET}` });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockSetupGmailWatch).toHaveBeenCalledWith(
        PUBSUB_TOPIC,
        expect.objectContaining({ email: MOCK_ACCOUNT.email })
      );
    });

    it("sin casillas conectadas devuelve 400 NO_MAILBOX, no 500", async () => {
      mockListEnabledGmailAccounts.mockResolvedValue([]);
      delete process.env.GMAIL_USER_EMAIL;

      const req = makeRequest({ authHeader: `Bearer ${CRON_SECRET}` });
      const res = await POST(req);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("NO_MAILBOX");
      expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    });
  });

  // ── AC14: Bearer CRON_SECRET ───────────────────────────────────────────────

  describe("AC14 — Authorization: Bearer <CRON_SECRET> → 200", () => {
    it("calls setupGmailWatch and returns 200 when using CRON_SECRET bearer token", async () => {
      const req = makeRequest({ authHeader: `Bearer ${CRON_SECRET}` });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.registered[0].historyId).toBe(MOCK_WATCH_RESULT.historyId);
      expect(body.registered[0].expiration).toBe(MOCK_WATCH_RESULT.expiration);
      expect(body.message).toBe("watch setup OK");
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

  describe("AC15 — PUBSUB_TOPIC missing → 500 PUBSUB_NOT_CONFIGURED", () => {
    it("returns 500 with PUBSUB_NOT_CONFIGURED when env var is not set", async () => {
      delete process.env.PUBSUB_TOPIC;
      const req = makeRequest({ authHeader: `Bearer ${CRON_SECRET}` });
      const res = await POST(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe("PUBSUB_NOT_CONFIGURED");
      expect(body.error.message).toMatch(/PUBSUB_TOPIC/);
      expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    });

    it("does not call setupGmailWatch when PUBSUB_TOPIC is missing", async () => {
      delete process.env.PUBSUB_TOPIC;
      const req = makeRequest({ authHeader: `Bearer ${CRON_SECRET}` });
      await POST(req);

      expect(mockSetupGmailWatch).not.toHaveBeenCalled();
    });

    it("returns 500 PUBSUB_NOT_CONFIGURED even with a valid internal credential", async () => {
      delete process.env.PUBSUB_TOPIC;
      const req = makeRequest({ authHeader: `Bearer ${CRON_SECRET}` });
      const res = await POST(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe("PUBSUB_NOT_CONFIGURED");
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  describe("error handling — setupGmailWatch throws", () => {
    it("returns 500 INTERNAL with generic message when setupGmailWatch throws", async () => {
      const err = new Error("Gmail API quota exceeded");
      mockSetupGmailWatch.mockRejectedValue(err);

      const req = makeRequest({ authHeader: `Bearer ${CRON_SECRET}` });
      const res = await POST(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe("INTERNAL");
      expect(body.error.message).toBe("Watch setup failed. Check server logs.");
      // raw error message must NOT be leaked to callers
      expect(body.error.message).not.toContain("Gmail API quota exceeded");
    });

    it("logs only the error name, not the full message", async () => {
      const err = Object.assign(new Error("sensitive internal detail"), {
        name: "GmailApiError",
      });
      mockSetupGmailWatch.mockRejectedValue(err);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const req = makeRequest({ authHeader: `Bearer ${CRON_SECRET}` });
      await POST(req);

      const loggedOutput = consoleSpy.mock.calls.flat().join(" ");
      expect(loggedOutput).toContain("GmailApiError");
      expect(loggedOutput).not.toContain("sensitive internal detail");
    });
  });
});
