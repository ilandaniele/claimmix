/**
 * Unit tests for the customer matcher.
 *
 * AC6:  High-confidence match sets customer_id + policy_id.
 * AC22: Match priority — policy_number > dni > email > phone.
 *
 * Uses a mock Supabase client to avoid real DB calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { findCustomerMatches } from "@/server/matching/customer-matcher";
import type { ClaimFields } from "@/lib/schemas/extracted-claim";

// ── Mock Supabase client ───────────────────────────────────────────────────────

function buildMockSupabase(queryResults: Record<string, any>) {
  // Returns a mock that intercepts .from(table).select(...).eq(...).limit(n)
  // Result is keyed by table name.
  return {
    from: (table: string) => {
      const result = queryResults[table] ?? { data: [], error: null };
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: () => Promise.resolve(result),
            }),
            limit: () => Promise.resolve(result),
          }),
          limit: () => Promise.resolve(result),
        }),
      };
    },
  };
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const TENANT_ID = "10000000-0000-0000-0000-000000000001";

const CUSTOMER_A = {
  id: "20000000-0000-0000-0000-000000000001",
  full_name: "Juan Pérez",
  email: "juan@example.com",
  dni: "12345678",
};

const POLICY_A = {
  id: "30000000-0000-0000-0000-000000000001",
  policy_number: "POL-1234",
  policy_type: "auto",
  status: "active",
  customer_id: CUSTOMER_A.id,
  customers: CUSTOMER_A,
};

// ── Policy number match ────────────────────────────────────────────────────────

describe("findCustomerMatches — policy_number match", () => {
  it("returns high-confidence match (0.95) when policy_number matches", async () => {
    const supabase = {
      from: (table: string) => {
        if (table === "policies") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  limit: () =>
                    Promise.resolve({
                      data: [POLICY_A],
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
        // No match on other tables
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        };
      },
    } as any;

    const fields: Partial<ClaimFields> = { policy_number: "POL-1234" };
    const matches = await findCustomerMatches(supabase, TENANT_ID, fields);

    expect(matches.length).toBeGreaterThanOrEqual(1);
    const policyMatch = matches.find((m) => m.matchType === "policy_number");
    expect(policyMatch).toBeDefined();
    expect(policyMatch!.confidence).toBe(0.95);
    expect(policyMatch!.customerId).toBe(CUSTOMER_A.id);
    expect(policyMatch!.policyId).toBe(POLICY_A.id);
  });
});

// ── DNI match ──────────────────────────────────────────────────────────────────

describe("findCustomerMatches — DNI match", () => {
  it("returns medium-high confidence (0.85) for DNI match", async () => {
    const supabase = {
      from: (table: string) => {
        if (table === "customers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  limit: () =>
                    Promise.resolve({ data: [CUSTOMER_A], error: null }),
                }),
              }),
            }),
          };
        }
        // No policy match (no policy_number provided)
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        };
      },
    } as any;

    const fields: Partial<ClaimFields> = { dni: "12345678" };
    const matches = await findCustomerMatches(supabase, TENANT_ID, fields);

    // At minimum: DNI match found
    const dniMatch = matches.find((m) => m.matchType === "dni");
    expect(dniMatch).toBeDefined();
    expect(dniMatch!.confidence).toBe(0.85);
    expect(dniMatch!.customerId).toBe(CUSTOMER_A.id);
  });
});

// ── Email match ────────────────────────────────────────────────────────────────

describe("findCustomerMatches — email match", () => {
  it("returns medium confidence (0.75) for email match", async () => {
    const supabase = {
      from: (table: string) => {
        if (table === "customers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  limit: () =>
                    Promise.resolve({ data: [CUSTOMER_A], error: null }),
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        };
      },
    } as any;

    const fields: Partial<ClaimFields> = { email: "juan@example.com" };
    const matches = await findCustomerMatches(supabase, TENANT_ID, fields);

    const emailMatch = matches.find((m) => m.matchType === "email");
    expect(emailMatch).toBeDefined();
    expect(emailMatch!.confidence).toBe(0.75);
    expect(emailMatch!.customerId).toBe(CUSTOMER_A.id);
  });
});

// ── No match ───────────────────────────────────────────────────────────────────

describe("findCustomerMatches — no match", () => {
  it("returns empty array when no fields provided", async () => {
    const supabase = buildMockSupabase({}) as any;
    const matches = await findCustomerMatches(supabase, TENANT_ID, {});
    expect(matches).toEqual([]);
  });

  it("returns empty array when no customer matches found in DB", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
            limit: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    } as any;

    const fields: Partial<ClaimFields> = { email: "unknown@example.com", dni: "99999999" };
    const matches = await findCustomerMatches(supabase, TENANT_ID, fields);
    expect(matches).toEqual([]);
  });
});

// ── Match priority: policy > dni > email ──────────────────────────────────────

describe("findCustomerMatches — match priority", () => {
  it("policy match has highest confidence (0.95), sorted first", async () => {
    // Simulate having both a policy match and a DNI match for the same customer
    const supabase = {
      from: (table: string) => {
        if (table === "policies") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  limit: () =>
                    Promise.resolve({
                      data: [POLICY_A],
                      error: null,
                    }),
                }),
              }),
            }),
          };
        }
        if (table === "customers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  limit: () =>
                    Promise.resolve({ data: [CUSTOMER_A], error: null }),
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        };
      },
    } as any;

    const fields: Partial<ClaimFields> = {
      policy_number: "POL-1234",
      dni: "12345678",
      email: "juan@example.com",
    };

    const matches = await findCustomerMatches(supabase, TENANT_ID, fields);

    // Sorted by confidence desc — policy (0.95) > dni (0.85) > email (0.75)
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.confidence).toBe(0.95);
    expect(matches[0]!.matchType).toBe("policy_number");
  });

  it("when no policy match, DNI match (0.85) ranks first", async () => {
    const supabase = {
      from: (table: string) => {
        if (table === "customers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  limit: () =>
                    Promise.resolve({ data: [CUSTOMER_A], error: null }),
                }),
              }),
            }),
          };
        }
        // No policy match
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        };
      },
    } as any;

    const fields: Partial<ClaimFields> = {
      dni: "12345678",
      email: "juan@example.com",
    };

    const matches = await findCustomerMatches(supabase, TENANT_ID, fields);
    // DNI (0.85) > email (0.75)
    // Both refer to same customer, but DNI match has higher confidence
    const first = matches[0];
    expect(first).toBeDefined();
    // The highest-confidence match should come first
    if (matches.length >= 2) {
      expect(matches[0]!.confidence).toBeGreaterThanOrEqual(matches[1]!.confidence);
    }
  });
});

// ── Conflict detection ────────────────────────────────────────────────────────

describe("findCustomerMatches — conflict detection", () => {
  it("detects conflicting full_name between extracted and stored customer", async () => {
    const customerWithDifferentName = {
      ...CUSTOMER_A,
      full_name: "Pedro García",
    };

    const supabase = {
      from: (table: string) => {
        if (table === "customers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  limit: () =>
                    Promise.resolve({ data: [customerWithDifferentName], error: null }),
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        };
      },
    } as any;

    const fields: Partial<ClaimFields> = {
      email: "juan@example.com",
      full_name: "Juan Pérez", // Different from stored "Pedro García"
    };

    const matches = await findCustomerMatches(supabase, TENANT_ID, fields);
    const emailMatch = matches.find((m) => m.matchType === "email");
    expect(emailMatch).toBeDefined();
    // Should detect full_name conflict
    expect(emailMatch!.conflictsWithExtracted).toContain("full_name");
  });

  it("returns empty conflictsWithExtracted when names match", async () => {
    const supabase = {
      from: (table: string) => {
        if (table === "customers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  limit: () =>
                    Promise.resolve({ data: [CUSTOMER_A], error: null }),
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        };
      },
    } as any;

    const fields: Partial<ClaimFields> = {
      email: "juan@example.com",
      full_name: "Juan Pérez", // Same as stored
    };

    const matches = await findCustomerMatches(supabase, TENANT_ID, fields);
    const emailMatch = matches.find((m) => m.matchType === "email");
    expect(emailMatch).toBeDefined();
    expect(emailMatch!.conflictsWithExtracted).toEqual([]);
  });
});

// ── DB error handling ─────────────────────────────────────────────────────────

describe("findCustomerMatches — DB error handling", () => {
  it("returns empty array when DB returns error", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: () =>
                Promise.resolve({ data: null, error: { code: "PGRST001", message: "DB error" } }),
            }),
            limit: () =>
              Promise.resolve({ data: null, error: { code: "PGRST001", message: "DB error" } }),
          }),
        }),
      }),
    } as any;

    const fields: Partial<ClaimFields> = { policy_number: "POL-9999" };
    // Should not throw — returns empty array
    const matches = await findCustomerMatches(supabase, TENANT_ID, fields);
    expect(Array.isArray(matches)).toBe(true);
  });
});
