/**
 * Unit tests for the cases list query builder.
 *
 * Uses a mocked Supabase client to test the query logic without a real DB.
 * Verifies filtering, pagination, and error handling behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { listCases, listCasesForExport } from "@/server/cases/list";

// ── Mock Supabase client builder ──────────────────────────────────────────────

function makeMockSupabase(
  countResult: { count: number | null; error: null | { code: string } },
  dataResult: { data: unknown[]; error: null | { code: string } }
) {
  const mockQuery = {
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockResolvedValue(dataResult),
    select: vi.fn().mockReturnThis(),
  };

  const countQuery = {
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue(countResult),
  };

  const supabase = {
    from: vi.fn((table: string) => {
      // Return different mock depending on whether select has head:true (count query)
      // We detect count query by checking if the second call to select has head: true.
      return {
        select: vi.fn((cols: string, options?: { count: string; head: boolean }) => {
          if (options?.head) {
            // Count query
            const q = {
              eq: vi.fn().mockReturnThis(),
              or: vi.fn().mockReturnThis(),
            };
            // Make the object itself thenable for the await
            return Object.assign(q, { then: (resolve: (v: typeof countResult) => void) => resolve(countResult) });
          }
          // Data query
          return mockQuery;
        }),
      };
    }),
  };

  return { supabase, mockQuery };
}

// ── listCases ─────────────────────────────────────────────────────────────────

describe("listCases", () => {
  const baseQuery = {
    status: undefined,
    type: undefined,
    q: undefined,
    page: 1,
    per_page: 20,
    sort: "created_at" as const,
    order: "desc" as const,
  };

  it("returns data and meta on success", async () => {
    const mockRows = [
      { id: "case-1", status: "listo", claim_type: "choque" },
      { id: "case-2", status: "listo", claim_type: "robo" },
    ];

    const supabase = buildChainedMock({ count: 2, data: mockRows });
    const result = await listCases(supabase, baseQuery);

    expect(result.data).toEqual(mockRows);
    expect(result.meta.total).toBe(2);
    expect(result.meta.page).toBe(1);
    expect(result.meta.per_page).toBe(20);
    expect(result.meta.pages).toBe(1);
  });

  it("calculates pages correctly", async () => {
    const supabase = buildChainedMock({ count: 55, data: [] });
    const result = await listCases(supabase, { ...baseQuery, per_page: 20 });
    // 55 / 20 = 2.75 → ceil = 3
    expect(result.meta.pages).toBe(3);
  });

  it("returns empty data when count is 0", async () => {
    const supabase = buildChainedMock({ count: 0, data: [] });
    const result = await listCases(supabase, baseQuery);
    expect(result.data).toEqual([]);
    expect(result.meta.total).toBe(0);
    expect(result.meta.pages).toBe(0);
  });

  it("throws when count query returns an error", async () => {
    const supabase = buildChainedMockWithCountError({ code: "42P01" }, []);
    await expect(listCases(supabase, baseQuery)).rejects.toThrow("[listCases] count error");
  });

  it("throws when data query returns an error", async () => {
    const supabase = buildChainedMockWithDataError(10, { code: "PGRST116" });
    await expect(listCases(supabase, baseQuery)).rejects.toThrow("[listCases] data error");
  });
});

// ── listCasesForExport ────────────────────────────────────────────────────────

describe("listCasesForExport", () => {
  it("returns array of case rows", async () => {
    const mockRows = [{ id: "case-1" }, { id: "case-2" }];
    const supabase = buildExportMock({ data: mockRows, error: null });
    const result = await listCasesForExport(supabase, {});
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no cases match", async () => {
    const supabase = buildExportMock({ data: [], error: null });
    const result = await listCasesForExport(supabase, { status: "cerrado" });
    expect(result).toEqual([]);
  });

  it("throws when Supabase returns an error", async () => {
    const supabase = buildExportMock({ data: null, error: { code: "PGRST301" } });
    await expect(listCasesForExport(supabase, {})).rejects.toThrow(
      "[listCasesForExport] error"
    );
  });
});

// ── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Build a chained mock supabase client that returns the given count and data.
 * Handles both the count query (.select(_, {head:true})) and data query chains.
 */
function buildChainedMock(opts: { count: number; data: unknown[] }) {
  const { count, data } = opts;

  // The count query result
  const countResult = { count, error: null };
  // The data query result (returned by the terminal range() call)
  const dataResult = { data, error: null };

  // A chainable object that returns itself for most calls
  const chainable = {
    eq: () => chainable,
    or: () => chainable,
    order: () => chainable,
    range: () => Promise.resolve(dataResult),
  };

  // A select that detects whether it's a count query or data query
  let selectCallCount = 0;
  const fromObj = {
    select: (_cols: string, options?: { head?: boolean }) => {
      selectCallCount++;
      if (options?.head) {
        // Count query
        const countChain = {
          eq: () => countChain,
          or: () => countChain,
          then: (resolve: (v: typeof countResult) => void) => Promise.resolve(countResult).then(resolve),
        };
        return countChain;
      }
      // Data query
      return chainable;
    },
  };

  return { from: () => fromObj };
}

function buildChainedMockWithCountError(countError: { code: string }, data: unknown[]) {
  const countResult = { count: null, error: countError };
  const dataResult = { data, error: null };

  const chainable = {
    eq: () => chainable,
    or: () => chainable,
    order: () => chainable,
    range: () => Promise.resolve(dataResult),
  };

  const fromObj = {
    select: (_cols: string, options?: { head?: boolean }) => {
      if (options?.head) {
        const countChain = {
          eq: () => countChain,
          or: () => countChain,
          then: (resolve: (v: typeof countResult) => void) => Promise.resolve(countResult).then(resolve),
        };
        return countChain;
      }
      return chainable;
    },
  };

  return { from: () => fromObj };
}

function buildChainedMockWithDataError(count: number, dataError: { code: string }) {
  const countResult = { count, error: null };
  const dataResult = { data: null, error: dataError };

  const chainable = {
    eq: () => chainable,
    or: () => chainable,
    order: () => chainable,
    range: () => Promise.resolve(dataResult),
  };

  const fromObj = {
    select: (_cols: string, options?: { head?: boolean }) => {
      if (options?.head) {
        const countChain = {
          eq: () => countChain,
          or: () => countChain,
          then: (resolve: (v: typeof countResult) => void) => Promise.resolve(countResult).then(resolve),
        };
        return countChain;
      }
      return chainable;
    },
  };

  return { from: () => fromObj };
}

function buildExportMock(result: { data: unknown[] | null; error: { code: string } | null }) {
  // For listCasesForExport: the query is built as:
  // supabase.from("cases").select(cols).order(...).range(...) then conditionally .eq(...)
  // We need the mock to return itself for all chained calls so .eq() doesn't fail.
  const terminal = () => Promise.resolve(result);

  // The tricky part: after .range() the code may still call .eq() if filters are provided.
  // The mock needs to be chainable through all these calls AND return the result at the end.
  // Solution: make every method return a new "chainable + thenable" object.
  const makeChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    chain["eq"] = () => makeChain();
    chain["or"] = () => makeChain();
    chain["order"] = () => makeChain();
    chain["range"] = () => makeChain();
    // Make thenable so await works
    chain["then"] = (resolve: (v: typeof result) => void) => Promise.resolve(result).then(resolve);
    chain["catch"] = (reject: (e: unknown) => void) => Promise.resolve(result).catch(reject);
    return chain;
  };

  return { from: () => ({ select: () => makeChain() }) };
}
