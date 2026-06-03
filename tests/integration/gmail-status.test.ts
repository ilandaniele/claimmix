/**
 * Integration tests for GET /api/admin/gmail-status.
 *
 * AC1: Returns 200 with masked email + is_connected=true when healthy row exists.
 * AC2: Returns graceful empty when no row exists.
 * AC6: Returns 403 when user is not admin (analyst role).
 * AC7: history_id is NOT in the response body at any depth.
 *
 * Runs against a mock Next.js request context using vi.mock for Supabase clients.
 * This avoids a live server dependency while still exercising the route handler logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Supabase clients ─────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));

// Mock rate-limit to always allow (not testing rate-limit in this suite).
vi.mock("@/lib/rate-limit/index", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit/index")>(
    "@/lib/rate-limit/index"
  );
  return {
    ...actual,
    rateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 99, resetAt: 0, retryAfterSeconds: 0 }),
  };
});

import { createServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { GET } from "@/app/api/admin/gmail-status/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a mock Supabase server client with a user of the given role. */
function buildServerClientMock(role: "admin" | "analyst" | null) {
  const userId = role ? "user-uuid-001" : null;
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: {
          user: role ? { id: userId, email: "test@example.com" } : null,
        },
        error: null,
      }),
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: role ? { id: userId, tenant_id: "tenant-001", role } : null,
        error: null,
      }),
    }),
  };
}

/** Build a mock service client with the given gmail_poll_state row (or null). */
function buildServiceClientMock(
  row: {
    gmail_account_email: string;
    last_polled_at: string | null;
    last_error: string | null;
  } | null
) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: row,
        error: null,
      }),
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/admin/gmail-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AC1: returns 200 with masked email and is_connected=true when healthy row exists", async () => {
    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildServerClientMock("admin")
    );
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      buildServiceClientMock({
        gmail_account_email: "gmail@claimmix.com",
        last_polled_at: "2026-06-03T00:00:00Z",
        last_error: null,
      })
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.email_address).toBe("g***@claimmix.com");
    expect(body.last_polled_at).toBe("2026-06-03T00:00:00Z");
    expect(body.is_connected).toBe(true);
    expect(body.last_error).toBeNull();
  });

  it("AC2: returns 200 with all-null shape when no row exists", async () => {
    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildServerClientMock("admin")
    );
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      buildServiceClientMock(null)
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      email_address: null,
      last_polled_at: null,
      is_connected: false,
      last_error: null,
    });
  });

  it("AC6: returns 403 FORBIDDEN when user has role=analyst", async () => {
    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildServerClientMock("analyst")
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN_ROLE");
  });

  it("returns 401 MISSING_SESSION when not authenticated", async () => {
    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildServerClientMock(null)
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("MISSING_SESSION");
  });

  it("AC7: history_id is NOT present in the response body at any depth", async () => {
    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildServerClientMock("admin")
    );
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      buildServiceClientMock({
        gmail_account_email: "g@example.com",
        last_polled_at: "2026-06-03T00:00:00Z",
        last_error: null,
      })
    );

    const response = await GET();
    const bodyText = await response.text();

    expect(bodyText).not.toContain("history_id");
    // Also verify it's not in the parsed JSON at any depth
    const body = JSON.parse(bodyText);
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("history_id");
  });

  it("returns is_connected=false when last_polled_at is null (unconfigured)", async () => {
    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildServerClientMock("admin")
    );
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      buildServiceClientMock({
        gmail_account_email: "g@example.com",
        last_polled_at: null,
        last_error: null,
      })
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.is_connected).toBe(false);
    expect(body.email_address).toBe("g***@example.com");
  });

  it("returns is_connected=false and last_error when last_error is set", async () => {
    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      buildServerClientMock("admin")
    );
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(
      buildServiceClientMock({
        gmail_account_email: "g@example.com",
        last_polled_at: "2026-06-03T00:00:00Z",
        last_error: "invalid_grant",
      })
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.is_connected).toBe(false);
    expect(body.last_error).toBe("invalid_grant");
  });
});
