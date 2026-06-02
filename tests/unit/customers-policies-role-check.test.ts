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

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  RATE_LIMIT_CONFIGS: { CASES_API: { limit: 100, windowMs: 60_000 } },
  buildUserKey: vi.fn((id: string, key: string) => `${id}:${key}`),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { createServerClient } from "@/lib/supabase/server";
import { NextRequest } from "next/server";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a mock Supabase client that returns the given user and role. */
function buildSupabaseMock(opts: {
  userId?: string | null;
  role?: string | null;
  customers?: any[];
  policies?: any[];
}) {
  const {
    userId = "user-uuid-001",
    role = "analyst",
    customers = [],
    policies = [],
  } = opts;

  const user = userId ? { id: userId } : null;

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    },
    from: (table: string) => {
      if (table === "users") {
        return {
          select: (_cols: string) => ({
            eq: (_col: string, _val: string) => ({
              single: () =>
                Promise.resolve({
                  data: role !== null ? { role } : null,
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "customers") {
        return {
          select: (_cols: string, _opts?: any) => ({
            count: customers.length,
            error: null,
            ilike: (_col: string, _val: string) => ({
              count: customers.length,
              error: null,
            }),
            order: (_col: string, _opts?: any) => ({
              range: (_from: number, _to: number) =>
                Promise.resolve({ data: customers, error: null }),
            }),
          }),
        };
      }
      if (table === "policies") {
        return {
          select: (_cols: string, _opts?: any) => ({
            count: policies.length,
            error: null,
            order: (_col: string, _opts?: any) => ({
              range: (_from: number, _to: number) =>
                Promise.resolve({ data: policies, error: null }),
            }),
          }),
        };
      }
      return {};
    },
  };
}

/** Build a NextRequest for GET requests (required by routes that use request.nextUrl). */
function makeGETRequest(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

// ── Tests: GET /api/customers ─────────────────────────────────────────────────

describe("GET /api/customers — role enforcement (B2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 FORBIDDEN_ROLE for analyst role", async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      buildSupabaseMock({ role: "analyst" }) as any
    );

    const { GET } = await import("@/app/api/customers/route");
    const request = makeGETRequest("http://localhost/api/customers");
    const response = await GET(request as any);

    expect(response.status).toBe(403);
    const body = await response.json() as any;
    expect(body.error.code).toBe("FORBIDDEN_ROLE");
  });

  it("returns 200 with data for admin role", async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      buildSupabaseMock({
        role: "admin",
        customers: [{ id: "c1", full_name: "Ana García", dni: "12345678", email: "ana@example.com", phone: null, created_at: "2024-01-01" }],
      }) as any
    );

    const { GET } = await import("@/app/api/customers/route");
    const request = makeGETRequest("http://localhost/api/customers");
    const response = await GET(request as any);

    // Admin role is allowed — should not be 403.
    expect(response.status).not.toBe(403);
    const body = await response.json() as any;
    // Should not contain an INSUFFICIENT_ROLE/FORBIDDEN_ROLE error.
    expect(body.error?.code).not.toBe("FORBIDDEN_ROLE");
  });

  it("returns 200 (not 403) for specialist role", async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      buildSupabaseMock({ role: "specialist", customers: [] }) as any
    );

    const { GET } = await import("@/app/api/customers/route");
    const request = makeGETRequest("http://localhost/api/customers");
    const response = await GET(request as any);

    expect(response.status).not.toBe(403);
    const body = await response.json() as any;
    expect(body.error?.code).not.toBe("FORBIDDEN_ROLE");
  });

  it("returns 401 for unauthenticated request (no user)", async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      buildSupabaseMock({ userId: null, role: null }) as any
    );

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
  });

  it("returns 403 FORBIDDEN_ROLE for analyst role", async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      buildSupabaseMock({ role: "analyst" }) as any
    );

    const { GET } = await import("@/app/api/policies/route");
    const request = makeGETRequest("http://localhost/api/policies");
    const response = await GET(request as any);

    expect(response.status).toBe(403);
    const body = await response.json() as any;
    expect(body.error.code).toBe("FORBIDDEN_ROLE");
  });

  it("returns 200 (not 403) for admin role", async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      buildSupabaseMock({ role: "admin", policies: [] }) as any
    );

    const { GET } = await import("@/app/api/policies/route");
    const request = makeGETRequest("http://localhost/api/policies");
    const response = await GET(request as any);

    expect(response.status).not.toBe(403);
    const body = await response.json() as any;
    expect(body.error?.code).not.toBe("FORBIDDEN_ROLE");
  });

  it("returns 200 (not 403) for specialist role", async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      buildSupabaseMock({ role: "specialist", policies: [] }) as any
    );

    const { GET } = await import("@/app/api/policies/route");
    const request = makeGETRequest("http://localhost/api/policies");
    const response = await GET(request as any);

    expect(response.status).not.toBe(403);
    const body = await response.json() as any;
    expect(body.error?.code).not.toBe("FORBIDDEN_ROLE");
  });

  it("returns 401 for unauthenticated request (no user)", async () => {
    vi.mocked(createServerClient).mockResolvedValue(
      buildSupabaseMock({ userId: null, role: null }) as any
    );

    const { GET } = await import("@/app/api/policies/route");
    const request = makeGETRequest("http://localhost/api/policies");
    const response = await GET(request as any);

    expect(response.status).toBe(401);
  });
});
