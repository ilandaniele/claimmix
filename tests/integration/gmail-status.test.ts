/**
 * Integration tests for GET /api/admin/gmail-status.
 *
 * AC1: Returns 200 with masked email + is_connected=true when healthy row exists.
 * AC2: Returns graceful empty when no row exists.
 * AC6: Returns 200 for analyst role — gmail-status is open to all authenticated users.
 * AC7: history_id is NOT in the response body at any depth.
 *
 * Runs against a mock Next.js request context using vi.mock for the db and
 * session. This avoids a live server dependency while still exercising the
 * route handler logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock factories ────────────────────────────────────────────────────

const { mockGetSessionContext, mockDbSelect, fakeUsersTable, fakeGmailPollStateTable } =
  vi.hoisted(() => {
    const fakeCol = () => Symbol("col");
    return {
      mockGetSessionContext: vi.fn(),
      mockDbSelect: vi.fn(),
      // Fake column reference objects — used as property references by the route
      // and requireAdmin. Passed to db.select({...}), .from(t), .where(eq(...)),
      // .orderBy(desc(...)), etc. Since our db mock ignores these arguments, they
      // only need to be truthy non-null values so property accesses don't throw.
      fakeUsersTable: {
        id: fakeCol(),
        tenant_id: fakeCol(),
        role: fakeCol(),
      },
      fakeGmailPollStateTable: {
        gmail_account_email: fakeCol(),
        last_polled_at: fakeCol(),
        last_error: fakeCol(),
        updated_at: fakeCol(),
      },
    };
  });

// ── Mock session (replaces Supabase auth.getUser) ─────────────────────────────

vi.mock("@/lib/auth/session", () => ({
  getSessionContext: mockGetSessionContext,
}));

// ── Mock @/lib/db ─────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
  },
  tables: {
    gmailPollState: fakeGmailPollStateTable,
  },
}));

// ── Mock @/lib/db/schema — requireAdmin imports `users` from here ─────────────

vi.mock("@/lib/db/schema", () => ({
  users: fakeUsersTable,
  gmailPollState: fakeGmailPollStateTable,
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

import { GET } from "@/app/api/admin/gmail-status/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

const USER_ID = "user-uuid-001";
const TENANT_ID = "tenant-001";

/**
 * Configure the db.select mock to handle two sequential select calls:
 *   1. requireRole() → users table lookup → returns the user row
 *   2. Route handler  → gmail_poll_state lookup → returns the status row
 *
 * Drizzle select chain:
 *   db.select(cols).from(table).where(...).limit(n)     → array
 *   db.select(cols).from(table).orderBy(...).limit(n)   → array
 */
function setupDbMock(
  role: "admin" | "analyst" | null,
  gmailRow: {
    gmail_account_email: string;
    last_polled_at: string | null;
    last_error: string | null;
  } | null
) {
  let callCount = 0;

  mockDbSelect.mockImplementation(() => {
    callCount++;
    const callIndex = callCount;

    // Build a fluent chain where every intermediate method returns the same
    // chain object. The terminal .limit() resolves to the appropriate array.
    const chain: Record<string, unknown> = {};
    const fluent = () => chain;
    chain.from = fluent;
    chain.where = fluent;
    chain.orderBy = fluent;

    if (callIndex === 1) {
      // requireAdmin: users table lookup
      chain.limit = () =>
        Promise.resolve(
          role
            ? [{ id: USER_ID, tenant_id: TENANT_ID, role }]
            : []
        );
    } else {
      // Route handler: gmail_poll_state query
      chain.limit = () =>
        Promise.resolve(
          gmailRow ? [gmailRow] : []
        );
    }

    return chain;
  });
}

/** Set up session mock for the given role (null = unauthenticated). */
function setupSession(role: "admin" | "analyst" | null) {
  if (!role) {
    mockGetSessionContext.mockResolvedValue(null);
  } else {
    mockGetSessionContext.mockResolvedValue({
      user: { id: USER_ID, email: "test@example.com" },
    });
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/admin/gmail-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AC1: returns 200 with masked email and is_connected=true when healthy row exists", async () => {
    setupSession("admin");
    setupDbMock("admin", {
      gmail_account_email: "gmail@claimmix.com",
      last_polled_at: "2026-06-03T00:00:00Z",
      last_error: null,
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.email_address).toBe("g***@claimmix.com");
    expect(body.last_polled_at).toBe("2026-06-03T00:00:00Z");
    expect(body.is_connected).toBe(true);
    expect(body.last_error).toBeNull();
  });

  it("AC2: returns 200 with all-null shape when no row exists", async () => {
    setupSession("admin");
    setupDbMock("admin", null);

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

  it("AC6: returns 200 for analyst role (gmail-status open to all users)", async () => {
    setupSession("analyst");
    setupDbMock("analyst", null);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toBeDefined();
    expect(body.data.is_connected).toBe(false);
  });

  it("returns 401 MISSING_SESSION when not authenticated", async () => {
    setupSession(null);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("MISSING_SESSION");
  });

  it("AC7: history_id is NOT present in the response body at any depth", async () => {
    setupSession("admin");
    setupDbMock("admin", {
      gmail_account_email: "g@example.com",
      last_polled_at: "2026-06-03T00:00:00Z",
      last_error: null,
    });

    const response = await GET();
    const bodyText = await response.text();

    expect(bodyText).not.toContain("history_id");
    // Also verify it's not in the parsed JSON at any depth
    const body = JSON.parse(bodyText);
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("history_id");
  });

  it("returns is_connected=false when last_polled_at is null (unconfigured)", async () => {
    setupSession("admin");
    setupDbMock("admin", {
      gmail_account_email: "g@example.com",
      last_polled_at: null,
      last_error: null,
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.is_connected).toBe(false);
    expect(body.email_address).toBe("g***@example.com");
  });

  it("returns is_connected=false and last_error when last_error is set", async () => {
    setupSession("admin");
    setupDbMock("admin", {
      gmail_account_email: "g@example.com",
      last_polled_at: "2026-06-03T00:00:00Z",
      last_error: "invalid_grant",
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.is_connected).toBe(false);
    expect(body.last_error).toBe("invalid_grant");
  });
});
