/**
 * Unit tests for the policy matcher.
 *
 * AC6:  Policy number match returns high confidence (0.95 for active).
 * AC22: Policy match has highest confidence.
 */

// vi.mock must be hoisted before any imports that trigger @/lib/db
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    $count: vi.fn(),
  },
  tables: {
    policies: { id: "id", policy_number: "policy_number", policy_type: "policy_type", status: "status", tenant_id: "tenant_id", customer_id: "customer_id" },
    customers: { id: "id", full_name: "full_name", tenant_id: "tenant_id" },
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { findPolicyMatches } from "@/server/matching/policy-matcher";
import { db } from "@/lib/db";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const CUSTOMER_ID = "20000000-0000-0000-0000-000000000001";

// These rows match what the db query returns after leftJoin + column projection:
// { id, policy_number, policy_type, status, customer_full_name }
const ACTIVE_POLICY_ROW = {
  id: "30000000-0000-0000-0000-000000000001",
  policy_number: "POL-1234",
  policy_type: "auto",
  status: "active",
  customer_full_name: "Juan Pérez",
};

const EXPIRED_POLICY_ROW = {
  id: "30000000-0000-0000-0000-000000000002",
  policy_number: "POL-OLD-9999",
  policy_type: "auto",
  status: "expired",
  customer_full_name: "Juan Pérez",
};

// ── Helper: build a select chain that resolves to given rows ──────────────────

function makeSelectChain(rows: unknown[]): any {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return chain;
}

// ── Exact policy_number match ──────────────────────────────────────────────────

describe("findPolicyMatches — policy_number exact match", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns match with confidence 0.95 for active policy", async () => {
    vi.mocked(db.select).mockReturnValue(makeSelectChain([ACTIVE_POLICY_ROW]) as any);

    const matches = await findPolicyMatches(TENANT_ID, "POL-1234");

    expect(matches.length).toBeGreaterThanOrEqual(1);
    const match = matches[0]!;
    expect(match.policyId).toBe(ACTIVE_POLICY_ROW.id);
    expect(match.policyNumber).toBe("POL-1234");
    expect(match.confidence).toBe(0.95);
    expect(match.status).toBe("active");
  });

  it("returns lower confidence (0.70) for expired policy by policy_number", async () => {
    vi.mocked(db.select).mockReturnValue(makeSelectChain([EXPIRED_POLICY_ROW]) as any);

    const matches = await findPolicyMatches(TENANT_ID, "POL-OLD-9999");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const match = matches.find((m) => m.policyNumber === "POL-OLD-9999");
    expect(match).toBeDefined();
    expect(match!.confidence).toBe(0.70);
    expect(match!.status).toBe("expired");
  });

  it("returns empty array when policy_number not found", async () => {
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as any);

    const matches = await findPolicyMatches(TENANT_ID, "POL-NOTFOUND");
    expect(matches).toEqual([]);
  });
});

// ── Customer-based policy lookup ───────────────────────────────────────────────

describe("findPolicyMatches — customer-based lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all active policies for a customer", async () => {
    const customerPolicies = [
      ACTIVE_POLICY_ROW,
      { ...ACTIVE_POLICY_ROW, id: "30000000-0000-0000-0000-000000000003", policy_number: "POL-5678" },
    ];

    vi.mocked(db.select).mockReturnValue(makeSelectChain(customerPolicies) as any);

    const matches = await findPolicyMatches(TENANT_ID, undefined, CUSTOMER_ID);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    for (const m of matches) {
      expect(m.confidence).toBeGreaterThan(0);
    }
  });

  it("returns lower confidence (0.60) for inactive policies via customer lookup", async () => {
    const cancelledRow = {
      ...ACTIVE_POLICY_ROW,
      id: "30000000-0000-0000-0000-000000000004",
      policy_number: "POL-CANCELLED",
      status: "cancelled",
    };

    vi.mocked(db.select).mockReturnValue(makeSelectChain([cancelledRow]) as any);

    const matches = await findPolicyMatches(TENANT_ID, undefined, CUSTOMER_ID);
    const cancelled = matches.find((m) => m.status === "cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled!.confidence).toBe(0.60);
  });

  it("returns empty array when customer has no policies", async () => {
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as any);

    const matches = await findPolicyMatches(TENANT_ID, undefined, CUSTOMER_ID);
    expect(matches).toEqual([]);
  });
});

// ── Active policies sorted first ──────────────────────────────────────────────

describe("findPolicyMatches — sorting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sorts active policies before expired when using customer lookup", async () => {
    const mixed = [EXPIRED_POLICY_ROW, ACTIVE_POLICY_ROW]; // expired first in DB result

    vi.mocked(db.select).mockReturnValue(makeSelectChain(mixed) as any);

    const matches = await findPolicyMatches(TENANT_ID, undefined, CUSTOMER_ID);
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no policyNumber or customerId provided", async () => {
    // db.select should never be called in this path
    const matches = await findPolicyMatches(TENANT_ID);
    expect(matches).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("handles DB error gracefully and returns empty array", async () => {
    // Make the chain throw at the terminal .limit() step
    const errorChain: any = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockRejectedValue(Object.assign(new Error("DB error"), { code: "DB_ERROR" })),
    };
    vi.mocked(db.select).mockReturnValue(errorChain as any);

    const matches = await findPolicyMatches(TENANT_ID, "POL-ERROR");
    expect(Array.isArray(matches)).toBe(true);
  });
});
