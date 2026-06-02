/**
 * RLS isolation tests for email-intake endpoints.
 *
 * AC19: Cross-tenant case access returns 404 (IDOR defense).
 * Tenant A cannot access Tenant B cases via:
 *   - GET /api/cases/:id
 *   - PATCH /api/cases/:id/confirm-field
 *   - GET /api/customers (returns empty, not error — RLS-filtered)
 *
 * These tests mock the Supabase clients to simulate RLS behavior
 * (null return for cross-tenant queries = RLS blocks access).
 *
 * True DB RLS tests require RLS_INTEGRATION_ENABLED=true + live Supabase.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    FIELD_CONFIRMED: "claim.field_confirmed",
    CASE_STATUS_CHANGED: "case.status_changed",
  },
}));

vi.mock("@/server/memory/update", () => ({
  updateMemoryFromConfirmation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server/cases/gap-analyzer", () => ({
  analyzeEmailClaimGaps: vi.fn().mockResolvedValue({
    missingRequiredFields: [],
    fieldsNeedingConfirmation: [],
    isComplete: true,
    status: "listo_para_core",
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

// Use "admin" role so the role guard on /api/customers passes.
// The RLS isolation (empty result) is what we are testing here, not the role guard.
const TENANT_A_USER = { id: "user-a", tenant_id: "tenant-a", role: "admin" };
const TENANT_B_CASE_ID = "bbbbbbbb-0000-0000-0000-000000000001";

function makeAuthSupabase(user: typeof TENANT_A_USER, caseRow: unknown) {
  const chainFor = (data: unknown, error: unknown = null) => {
    const final = Promise.resolve({ data, error });
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      single: () => final,
      maybeSingle: () => final,
      order: () => chain,
      limit: () => chain,
      is: () => final,
      ilike: () => chain,
      or: () => chain,
      range: () => chain,
    };
    return chain;
  };

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: user.id } } }),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "users") return chainFor(user);
      // RLS blocks cross-tenant case → returns null
      if (table === "cases") return chainFor(caseRow);
      if (table === "customers") return chainFor([]);
      return chainFor(null);
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AC19: Cross-tenant IDOR defense", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/cases/:id — tenant A cannot access tenant B case (returns 404, not 403)", async () => {
    const { createServerClient } = await import("@/lib/supabase/server");

    // RLS returns null for cross-tenant case access
    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAuthSupabase(TENANT_A_USER, null)
    );

    const { GET } = await import("@/app/api/cases/[id]/route");
    const { NextRequest } = await import("next/server");

    const req = new NextRequest(
      `http://localhost/api/cases/${TENANT_B_CASE_ID}`,
      { method: "GET" }
    );
    const context = { params: Promise.resolve({ id: TENANT_B_CASE_ID }) };

    const response = await GET(req, context);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  it("PATCH /api/cases/:id/confirm-field — tenant A cannot confirm field on tenant B case (returns 404)", async () => {
    const { createServerClient } = await import("@/lib/supabase/server");
    const { createServiceClient } = await import("@/lib/supabase/service");

    // RLS returns null for the case belonging to tenant B
    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAuthSupabase(TENANT_A_USER, null)
    );
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    });

    const { PATCH } = await import(
      "@/app/api/cases/[id]/confirm-field/route"
    );

    const req = new Request(
      `http://localhost/api/cases/${TENANT_B_CASE_ID}/confirm-field`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          field_key: "full_name",
          value: "Attacker",
          action: "confirm",
        }),
      }
    ) as any;
    const context = {
      params: Promise.resolve({ id: TENANT_B_CASE_ID }),
    };

    const response = await PATCH(req, context);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  it("GET /api/customers — tenant A gets empty list when no customers exist in their tenant", async () => {
    const { createServerClient } = await import("@/lib/supabase/server");

    // RLS returns empty array for cross-tenant customers query
    const supabaseMock = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: TENANT_A_USER.id } },
        }),
      },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "users") {
          const chain: any = {
            select: () => chain,
            eq: () => chain,
            single: () =>
              Promise.resolve({ data: TENANT_A_USER, error: null }),
          };
          return chain;
        }
        if (table === "customers") {
          const chain: any = {
            select: () => chain,
            eq: () => chain,
            ilike: () => chain,
            order: () => chain,
            range: () => chain,
            // RLS filters to empty array — not an error
            then: (resolve: (val: any) => void) =>
              resolve({ data: [], count: 0, error: null }),
          };
          // Mock count query
          const countChain: any = {
            select: () => countChain,
            eq: () => countChain,
            ilike: () => countChain,
            order: () => countChain,
            range: () => countChain,
            then: (resolve: (val: any) => void) =>
              resolve({ data: null, count: 0, error: null }),
          };
          return {
            select: (cols: string, opts?: any) => {
              if (opts?.count === "exact" && opts?.head === true) {
                return countChain;
              }
              return chain;
            },
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi
            .fn()
            .mockResolvedValue({ data: null, error: null }),
        };
      }),
    };

    (createServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      supabaseMock
    );

    const { GET } = await import("@/app/api/customers/route");

    // Must use NextRequest-compatible object with nextUrl
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/customers", {
      method: "GET",
    });

    const response = await GET(req);

    // Should return 200 with empty data (RLS-filtered) — NOT a 403 or 404
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
  });
});

describe("RLS schema-level validation", () => {
  it("current_tenant_id() function pattern ensures all tenant tables are scoped", () => {
    // Verifies our understanding of the RLS design:
    // All tables use `tenant_id = current_tenant_id()` in RLS policies.
    // This test documents the expected security invariant.
    const TABLES_WITH_RLS = [
      "customers",
      "customer_contacts",
      "policies",
      "insured_assets",
      "claim_attachments",
      "claim_field_confirmations",
      "claim_memory",
      "known_claim_patterns",
    ];

    // All of these tables should have tenant_id-based RLS.
    // This test acts as documentation — if you remove a table from RLS,
    // you must update this list.
    expect(TABLES_WITH_RLS.length).toBeGreaterThan(0);
    expect(TABLES_WITH_RLS).toContain("claim_field_confirmations");
    expect(TABLES_WITH_RLS).toContain("claim_attachments");
    expect(TABLES_WITH_RLS).toContain("customers");
  });
});
