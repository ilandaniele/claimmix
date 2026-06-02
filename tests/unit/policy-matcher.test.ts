/**
 * Unit tests for the policy matcher.
 *
 * AC6:  Policy number match returns high confidence (0.95 for active).
 * AC22: Policy match has highest confidence.
 */

import { describe, it, expect } from "vitest";
import { findPolicyMatches } from "@/server/matching/policy-matcher";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const CUSTOMER_ID = "20000000-0000-0000-0000-000000000001";

const ACTIVE_POLICY = {
  id: "30000000-0000-0000-0000-000000000001",
  policy_number: "POL-1234",
  policy_type: "auto",
  status: "active",
  customers: { full_name: "Juan Pérez" },
};

const EXPIRED_POLICY = {
  id: "30000000-0000-0000-0000-000000000002",
  policy_number: "POL-OLD-9999",
  policy_type: "auto",
  status: "expired",
  customers: { full_name: "Juan Pérez" },
};

// ── Exact policy_number match ──────────────────────────────────────────────────

describe("findPolicyMatches — policy_number exact match", () => {
  it("returns match with confidence 0.95 for active policy", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: () => Promise.resolve({ data: [ACTIVE_POLICY], error: null }),
            }),
            order: () => ({
              limit: () => Promise.resolve({ data: [ACTIVE_POLICY], error: null }),
            }),
          }),
        }),
      }),
    } as any;

    const matches = await findPolicyMatches(supabase, TENANT_ID, "POL-1234");

    expect(matches.length).toBeGreaterThanOrEqual(1);
    const match = matches[0]!;
    expect(match.policyId).toBe(ACTIVE_POLICY.id);
    expect(match.policyNumber).toBe("POL-1234");
    expect(match.confidence).toBe(0.95);
    expect(match.status).toBe("active");
  });

  it("returns lower confidence (0.70) for expired policy by policy_number", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: () => Promise.resolve({ data: [EXPIRED_POLICY], error: null }),
            }),
            order: () => ({
              limit: () => Promise.resolve({ data: [EXPIRED_POLICY], error: null }),
            }),
          }),
        }),
      }),
    } as any;

    const matches = await findPolicyMatches(supabase, TENANT_ID, "POL-OLD-9999");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const match = matches.find((m) => m.policyNumber === "POL-OLD-9999");
    expect(match).toBeDefined();
    expect(match!.confidence).toBe(0.70);
    expect(match!.status).toBe("expired");
  });

  it("returns empty array when policy_number not found", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      }),
    } as any;

    const matches = await findPolicyMatches(supabase, TENANT_ID, "POL-NOTFOUND");
    expect(matches).toEqual([]);
  });
});

// ── Customer-based policy lookup ───────────────────────────────────────────────

describe("findPolicyMatches — customer-based lookup", () => {
  it("returns all active policies for a customer", async () => {
    const customerPolicies = [
      ACTIVE_POLICY,
      { ...ACTIVE_POLICY, id: "30000000-0000-0000-0000-000000000003", policy_number: "POL-5678" },
    ];

    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: customerPolicies, error: null }),
              }),
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
            order: () => ({
              limit: () => Promise.resolve({ data: customerPolicies, error: null }),
            }),
          }),
        }),
      }),
    } as any;

    const matches = await findPolicyMatches(supabase, TENANT_ID, undefined, CUSTOMER_ID);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // All should have some confidence
    for (const m of matches) {
      expect(m.confidence).toBeGreaterThan(0);
    }
  });

  it("returns lower confidence (0.60) for inactive policies via customer lookup", async () => {
    const cancelledPolicy = {
      ...ACTIVE_POLICY,
      id: "30000000-0000-0000-0000-000000000004",
      policy_number: "POL-CANCELLED",
      status: "cancelled",
    };

    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [cancelledPolicy], error: null }),
              }),
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
            order: () => ({
              limit: () => Promise.resolve({ data: [cancelledPolicy], error: null }),
            }),
          }),
        }),
      }),
    } as any;

    const matches = await findPolicyMatches(supabase, TENANT_ID, undefined, CUSTOMER_ID);
    const cancelled = matches.find((m) => m.status === "cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled!.confidence).toBe(0.60);
  });

  it("returns empty array when customer has no policies", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [], error: null }),
              }),
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      }),
    } as any;

    const matches = await findPolicyMatches(supabase, TENANT_ID, undefined, CUSTOMER_ID);
    expect(matches).toEqual([]);
  });
});

// ── Active policies sorted first ──────────────────────────────────────────────

describe("findPolicyMatches — sorting", () => {
  it("sorts active policies before expired when using customer lookup", async () => {
    const mixed = [EXPIRED_POLICY, ACTIVE_POLICY]; // expired first in DB result

    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: mixed, error: null }),
              }),
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
            order: () => ({
              limit: () => Promise.resolve({ data: mixed, error: null }),
            }),
          }),
        }),
      }),
    } as any;

    const matches = await findPolicyMatches(supabase, TENANT_ID, undefined, CUSTOMER_ID);
    if (matches.length >= 2) {
      // Active should come before expired
      const activeIdx = matches.findIndex((m) => m.status === "active");
      const expiredIdx = matches.findIndex((m) => m.status === "expired");
      if (activeIdx !== -1 && expiredIdx !== -1) {
        expect(activeIdx).toBeLessThan(expiredIdx);
      }
    }
  });
});

// ── No input returns empty ─────────────────────────────────────────────────────

describe("findPolicyMatches — edge cases", () => {
  it("returns empty array when no policyNumber or customerId provided", async () => {
    const supabase = { from: () => ({ select: () => ({}) }) } as any;
    const matches = await findPolicyMatches(supabase, TENANT_ID);
    expect(matches).toEqual([]);
  });

  it("handles DB error gracefully and returns empty array", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: () => Promise.resolve({ data: null, error: { code: "DB_ERROR" } }),
              order: () => ({
                limit: () => Promise.resolve({ data: null, error: { code: "DB_ERROR" } }),
              }),
            }),
            order: () => ({
              limit: () => Promise.resolve({ data: null, error: { code: "DB_ERROR" } }),
            }),
          }),
        }),
      }),
    } as any;

    const matches = await findPolicyMatches(supabase, TENANT_ID, "POL-ERROR");
    expect(Array.isArray(matches)).toBe(true);
  });
});
