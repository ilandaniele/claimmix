/**
 * Unit tests for the cases list query builder.
 *
 * Uses a mocked Drizzle db to test the query logic without a real DB.
 * Verifies filtering, pagination, and error handling behavior.
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
  tables: {},
}));

// countRows calls db.$count — mock the helper module so it delegates to our mocked db.$count
vi.mock("@/lib/db/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/helpers")>();
  return {
    ...actual,
    countRows: vi.fn(),
    firstRow: actual.firstRow,
  };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { listCases, listCasesForExport } from "@/server/cases/list";
import { db } from "@/lib/db";
import { countRows } from "@/lib/db/helpers";

// ── Base query fixture ────────────────────────────────────────────────────────

const TENANT_ID = "tenant-1";

const baseQuery = {
  status: undefined,
  type: undefined,
  q: undefined,
  page: 1,
  per_page: 20,
  sort: "created_at" as const,
  order: "desc" as const,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a chainable mock for db.select() that resolves to `rows` at any
 * terminal step (.limit(), .offset(), or awaiting directly).
 */
function makeSelectChain(rows: unknown[]): any {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockResolvedValue(rows),
    // For listCasesForExport the terminal call is .limit() not .offset()
    // We override this below per test.
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
    catch: (onRejected: (e: unknown) => void) =>
      Promise.resolve(rows).catch(onRejected),
  };
  // Make .limit() also awaitable directly (needed for export path)
  chain.limit.mockImplementation(() => {
    const limitChain: any = {
      ...chain,
      offset: vi.fn().mockResolvedValue(rows),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        Promise.resolve(rows).then(resolve, reject),
      catch: (onRejected: (e: unknown) => void) =>
        Promise.resolve(rows).catch(onRejected),
    };
    return limitChain;
  });
  return chain;
}

// ── listCases ─────────────────────────────────────────────────────────────────

describe("listCases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns data and meta on success", async () => {
    const mockRows = [
      { id: "case-1", status: "listo", claim_type: "choque", policyholder_name: "Juan", policy_number: "POL-1" },
      { id: "case-2", status: "listo", claim_type: "robo", policyholder_name: "Ana", policy_number: "POL-2" },
    ];

    vi.mocked(countRows).mockResolvedValue(2);
    vi.mocked(db.select).mockReturnValue(makeSelectChain(mockRows) as any);

    const result = await listCases(TENANT_ID, baseQuery);

    expect(result.data).toEqual(mockRows);
    expect(result.meta.total).toBe(2);
    expect(result.meta.page).toBe(1);
    expect(result.meta.per_page).toBe(20);
    expect(result.meta.pages).toBe(1);
  });

  it("calculates pages correctly", async () => {
    vi.mocked(countRows).mockResolvedValue(55);
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as any);

    const result = await listCases(TENANT_ID, { ...baseQuery, per_page: 20 });
    // 55 / 20 = 2.75 → ceil = 3
    expect(result.meta.pages).toBe(3);
  });

  it("returns empty data when count is 0", async () => {
    vi.mocked(countRows).mockResolvedValue(0);
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as any);

    const result = await listCases(TENANT_ID, baseQuery);
    expect(result.data).toEqual([]);
    expect(result.meta.total).toBe(0);
    expect(result.meta.pages).toBe(0);
  });

  it("throws when count query returns an error", async () => {
    const err = new Error("relation does not exist");
    (err as any).code = "42P01";
    vi.mocked(countRows).mockRejectedValue(err);

    await expect(listCases(TENANT_ID, baseQuery)).rejects.toThrow("[listCases] count error");
  });

  it("throws when data query returns an error", async () => {
    vi.mocked(countRows).mockResolvedValue(10);

    // Make the chain throw at the terminal step (.offset())
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockRejectedValue(Object.assign(new Error("no rows"), { code: "PGRST116" })),
    };
    vi.mocked(db.select).mockReturnValue(chain as any);

    await expect(listCases(TENANT_ID, baseQuery)).rejects.toThrow("[listCases] data error");
  });
});

// ── listCasesForExport ────────────────────────────────────────────────────────

describe("listCasesForExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns array of case rows", async () => {
    const mockRows = [{ id: "case-1" }, { id: "case-2" }];

    // Export chain: db.select().from().where().orderBy().limit() → resolves
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockRows),
    };
    vi.mocked(db.select).mockReturnValue(chain as any);

    const result = await listCasesForExport(TENANT_ID, {});
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no cases match", async () => {
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(db.select).mockReturnValue(chain as any);

    const result = await listCasesForExport(TENANT_ID, { status: "cerrado" });
    expect(result).toEqual([]);
  });

  it("throws when the DB query errors", async () => {
    const dbErr = Object.assign(new Error("permission denied"), { code: "PGRST301" });
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockRejectedValue(dbErr),
    };
    vi.mocked(db.select).mockReturnValue(chain as any);

    await expect(listCasesForExport(TENANT_ID, {})).rejects.toThrow(
      "[listCasesForExport] error"
    );
  });
});
