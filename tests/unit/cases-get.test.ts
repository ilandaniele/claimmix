/**
 * Unit tests for the case detail query builder.
 *
 * Uses a mocked Drizzle db to test IDOR handling and response structure.
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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCaseDetail } from "@/server/cases/get";
import { db } from "@/lib/db";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const TENANT_ID = "tenant-1";

const mockCase = {
  id: "case-uuid-1",
  tenant_id: TENANT_ID,
  status: "listo",
  claim_type: "choque",
};

const mockExtractedFields = [
  { id: "ef-1", case_id: "case-uuid-1", field_key: "date", field_value: "2024-01-15", confidence: 0.95 },
  { id: "ef-2", case_id: "case-uuid-1", field_key: "location", field_value: "Av. Corrientes 1234", confidence: 0.88 },
];

const mockMissingDocs = [
  { id: "md-1", case_id: "case-uuid-1", doc_key: "foto_oblea_vtv" },
];

const mockAuditEntries = [
  { id: 1, event_type: "case.status_changed", created_at: "2024-01-15T10:00:00Z" },
  { id: 2, event_type: "case.closed", created_at: "2024-01-16T12:00:00Z" },
];

// ── Helper: configure db.select mock chain ────────────────────────────────────

/**
 * Sets up the db.select mock to return:
 * - caseRows on the first call  (cases query:          .from().where().limit() )
 * - extractedRows on 2nd call   (extracted_fields:     .from().where().orderBy().catch() )
 * - missingRows on 3rd call     (missing_docs:         .from().where().orderBy().catch() )
 * - auditRows on 4th call       (audit_log:            .from().where().orderBy().limit().catch() )
 *
 * IMPORTANT: intermediate chain steps (from, where, orderBy) must NOT be
 * thenable — making them thenable causes `await chain` to resolve before
 * .limit() is called. Only the terminal step resolves.
 *
 * The parallel queries use .catch(() => []) — so the chain must be a real
 * Promise-like value at the point where .catch() is called.
 * Chain: db.select().from().where().orderBy() returns a Promise (resolved via
 * mockResolvedValue on the last chained call).
 */
function setupSelectMock(opts: {
  caseRows: unknown[];
  extractedRows: unknown[];
  missingRows: unknown[];
  auditRows: unknown[];
}) {
  const { caseRows, extractedRows, missingRows, auditRows } = opts;

  /**
   * Build a non-thenable chain where:
   * - .from() / .where() return the chain (not a Promise)
   * - .limit() resolves to rows (cases query uses .limit())
   * - .orderBy() returns an object that is a Promise AND has .limit()
   *   (extracted_fields/missing_docs await .orderBy(); audit_log calls .limit() on it)
   */
  const makeChain = (resolveValue: unknown[]): any => {
    // afterOrderBy: a Promise that also has .limit()
    const afterOrderBy: Promise<unknown[]> & { limit: () => Promise<unknown[]> } = Object.assign(
      Promise.resolve(resolveValue),
      { limit: vi.fn().mockResolvedValue(resolveValue) }
    );

    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnValue(afterOrderBy),
      limit: vi.fn().mockResolvedValue(resolveValue),
    };
    return chain;
  };

  let callCount = 0;
  vi.mocked(db.select).mockImplementation(() => {
    callCount++;
    const call = callCount;

    if (call === 1) return makeChain(caseRows);
    if (call === 2) return makeChain(extractedRows);
    if (call === 3) return makeChain(missingRows);
    return makeChain(auditRows);
  });
}

// ── getCaseDetail ─────────────────────────────────────────────────────────────

describe("getCaseDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns CaseDetail for an existing case", async () => {
    setupSelectMock({
      caseRows: [mockCase],
      extractedRows: [],
      missingRows: [],
      auditRows: [],
    });

    const result = await getCaseDetail(TENANT_ID, "case-uuid-1");
    expect(result).not.toBeNull();
    expect(result!.case).toEqual(mockCase);
    expect(result!.extracted_fields).toEqual([]);
    expect(result!.missing_docs).toEqual([]);
    expect(result!.audit_log).toEqual([]);
  });

  it("returns null when case is not found (IDOR prevention)", async () => {
    setupSelectMock({
      caseRows: [],
      extractedRows: [],
      missingRows: [],
      auditRows: [],
    });

    const result = await getCaseDetail(TENANT_ID, "non-existent-uuid");
    // IDOR: not found or wrong tenant → null, caller returns 404 (never 403)
    expect(result).toBeNull();
  });

  it("returns null when the case belongs to a different tenant (wrong tenant filter returns no rows)", async () => {
    // Explicit tenant filter means wrong-tenant case returns zero rows
    setupSelectMock({
      caseRows: [],
      extractedRows: [],
      missingRows: [],
      auditRows: [],
    });

    const result = await getCaseDetail(TENANT_ID, "another-tenant-case");
    expect(result).toBeNull();
  });

  it("returns null when the db.select throws (invalid uuid, etc.)", async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error("invalid input syntax for type uuid");
    });

    const result = await getCaseDetail(TENANT_ID, "not-a-uuid");
    expect(result).toBeNull();
  });

  it("includes extracted_fields when present", async () => {
    setupSelectMock({
      caseRows: [mockCase],
      extractedRows: mockExtractedFields,
      missingRows: [],
      auditRows: [],
    });

    const result = await getCaseDetail(TENANT_ID, "case-uuid-1");
    expect(result).not.toBeNull();
    expect(result!.extracted_fields).toHaveLength(2);
    expect(result!.extracted_fields[0].field_key).toBe("date");
  });

  it("includes missing_docs when present", async () => {
    setupSelectMock({
      caseRows: [mockCase],
      extractedRows: [],
      missingRows: mockMissingDocs,
      auditRows: [],
    });

    const result = await getCaseDetail(TENANT_ID, "case-uuid-1");
    expect(result).not.toBeNull();
    expect(result!.missing_docs).toHaveLength(1);
    expect(result!.missing_docs[0].doc_key).toBe("foto_oblea_vtv");
  });

  it("includes audit_log when present", async () => {
    setupSelectMock({
      caseRows: [mockCase],
      extractedRows: [],
      missingRows: [],
      auditRows: mockAuditEntries,
    });

    const result = await getCaseDetail(TENANT_ID, "case-uuid-1");
    expect(result).not.toBeNull();
    expect(result!.audit_log).toHaveLength(2);
  });
});
