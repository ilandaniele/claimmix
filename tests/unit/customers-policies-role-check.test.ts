/**
 * Unit tests for API5 role enforcement on:
 *   GET /api/customers — admin or specialist only
 *   GET /api/policies  — admin or specialist only
 *
 * B2: Analyst role → 403 FORBIDDEN_ROLE
 *     Admin role   → 200 with results
 *     Specialist   → 200 with results
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

const { mockDb, mockGetSessionContext } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    $count: vi.fn(),
  };
  return {
    mockDb,
    mockGetSessionContext: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: mockDb,
  tables: {},
}));

vi.mock("@/lib/db/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/helpers")>();
  return {
    ...actual,
    firstRow: actual.firstRow,
  };
});

vi.mock("@/lib/auth/session", () => ({
  getSessionContext: mockGetSessionContext,
}));

vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  RATE_LIMIT_CONFIGS: { CASES_API: { limit: 100, windowMs: 60_000 } },
  buildUserKey: vi.fn((id: string, key: string) => `${id}:${key}`),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { NextRequest } from "next/server";

// ── Helpers ───────────────────────────────────────────────────────────────────

const USER_ID = "user-uuid-001";
const TENANT_ID = "tenant-uuid-001";

/** Build a NextRequest for GET requests. */
function makeGETRequest(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

/**
 * Configure mocks for a user with a given role.
 * db.select returns the user row; db.$count and the data select return empty results.
 */
function setupDbForRole(role: string | null) {
  // db.select chain: used by the route to load the user row
  // .select({...}).from(users).where(...).limit(1) → [userRow] or []
  const userRows =
    role !== null
      ? [{ role, tenant_id: TENANT_ID }]
      : [];

  const selectChain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockResolvedValue([]),
  };

  // First call is for users table (role check), subsequent calls are data queries
  let callCount = 0;
  mockDb.select.mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // User row lookup
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(userRows),
      };
    }
    // Data query (customers or policies listing)
    return selectChain;
  });

  mockDb.$count.mockResolvedValue(0);
}

/** Configure session to return a logged-in user. */
function setupSession(userId: string | null) {
  if (userId === null) {
    mockGetSessionContext.mockResolvedValue(null);
  } else {
    mockGetSessionContext.mockResolvedValue({
      user: { id: userId, email: "test@example.com" },
    });
  }
}

// ── Tests: GET /api/customers ─────────────────────────────────────────────────

describe("GET /api/customers — role enforcement (B2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset call counter hack by reassigning fresh mock
    mockDb.select.mockReset();
    mockDb.$count.mockReset();
  });

  it("returns 403 FORBIDDEN_ROLE for analyst role", async () => {
    setupSession(USER_ID);
    setupDbForRole("analyst");

    const { GET } = await import("@/app/api/customers/route");
    const request = makeGETRequest("http://localhost/api/customers");
    const response = await GET(request as any);

    expect(response.status).toBe(403);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe("FORBIDDEN_ROLE");
  });

  it("returns 200 with data for admin role", async () => {
    setupSession(USER_ID);
    setupDbForRole("admin");

    const { GET } = await import("@/app/api/customers/route");
    const request = makeGETRequest("http://localhost/api/customers");
    const response = await GET(request as any);

    // Admin role is allowed — should not be 403.
    expect(response.status).not.toBe(403);
    const body = (await response.json()) as any;
    // Should not contain an INSUFFICIENT_ROLE/FORBIDDEN_ROLE error.
    expect(body.error?.code).not.toBe("FORBIDDEN_ROLE");
  });

  it("returns 200 (not 403) for specialist role", async () => {
    setupSession(USER_ID);
    setupDbForRole("specialist");

    const { GET } = await import("@/app/api/customers/route");
    const request = makeGETRequest("http://localhost/api/customers");
    const response = await GET(request as any);

    expect(response.status).not.toBe(403);
    const body = (await response.json()) as any;
    expect(body.error?.code).not.toBe("FORBIDDEN_ROLE");
  });

  /*
   * `owner` recibía 403 en su propia aseguradora.
   *
   * La lista de roles estaba escrita a mano acá —`["admin","specialist"]`—
   * mientras el resto del producto documenta a owner como «todo lo que puede
   * hacer un admin». Nadie lo pegaba porque hoy no existe ningún owner: se
   * crea sólo por SQL directo. Era un agujero esperando al primero.
   *
   * Este test no existía, y por eso el hueco era silencio y no una decisión.
   */
  it("returns 200 (not 403) for owner role", async () => {
    setupSession(USER_ID);
    setupDbForRole("owner");

    const { GET } = await import("@/app/api/customers/route");
    const request = makeGETRequest("http://localhost/api/customers");
    const response = await GET(request as any);

    expect(response.status).not.toBe(403);
    const body = (await response.json()) as any;
    expect(body.error?.code).not.toBe("FORBIDDEN_ROLE");
  });
  it("returns 401 for unauthenticated request (no user)", async () => {
    setupSession(null);

    const { GET } = await import("@/app/api/customers/route");
    const request = makeGETRequest("http://localhost/api/customers");
    const response = await GET(request as any);

    expect(response.status).toBe(401);
  });
});

// ── Tests: GET /api/policies ──────────────────────────────────────────────────

describe("GET /api/policies — role enforcement (B2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReset();
    mockDb.$count.mockReset();
  });

  it("returns 403 FORBIDDEN_ROLE for analyst role", async () => {
    setupSession(USER_ID);
    setupDbForRole("analyst");

    const { GET } = await import("@/app/api/policies/route");
    const request = makeGETRequest("http://localhost/api/policies");
    const response = await GET(request as any);

    expect(response.status).toBe(403);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe("FORBIDDEN_ROLE");
  });

  it("returns 200 (not 403) for admin role", async () => {
    setupSession(USER_ID);
    setupDbForRole("admin");

    const { GET } = await import("@/app/api/policies/route");
    const request = makeGETRequest("http://localhost/api/policies");
    const response = await GET(request as any);

    expect(response.status).not.toBe(403);
    const body = (await response.json()) as any;
    expect(body.error?.code).not.toBe("FORBIDDEN_ROLE");
  });

  it("returns 200 (not 403) for specialist role", async () => {
    setupSession(USER_ID);
    setupDbForRole("specialist");

    const { GET } = await import("@/app/api/policies/route");
    const request = makeGETRequest("http://localhost/api/policies");
    const response = await GET(request as any);

    expect(response.status).not.toBe(403);
    const body = (await response.json()) as any;
    expect(body.error?.code).not.toBe("FORBIDDEN_ROLE");
  });

  /*
   * `owner` recibía 403 en su propia aseguradora.
   *
   * La lista de roles estaba escrita a mano acá —`["admin","specialist"]`—
   * mientras el resto del producto documenta a owner como «todo lo que puede
   * hacer un admin». Nadie lo pegaba porque hoy no existe ningún owner: se
   * crea sólo por SQL directo. Era un agujero esperando al primero.
   *
   * Este test no existía, y por eso el hueco era silencio y no una decisión.
   */
  it("returns 200 (not 403) for owner role", async () => {
    setupSession(USER_ID);
    setupDbForRole("owner");

    const { GET } = await import("@/app/api/policies/route");
    const request = makeGETRequest("http://localhost/api/policies");
    const response = await GET(request as any);

    expect(response.status).not.toBe(403);
    const body = (await response.json()) as any;
    expect(body.error?.code).not.toBe("FORBIDDEN_ROLE");
  });

  it("returns 401 for unauthenticated request (no user)", async () => {
    setupSession(null);

    const { GET } = await import("@/app/api/policies/route");
    const request = makeGETRequest("http://localhost/api/policies");
    const response = await GET(request as any);

    expect(response.status).toBe(401);
  });
});
