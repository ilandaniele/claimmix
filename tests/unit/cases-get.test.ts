/**
 * Unit tests for the case detail query builder.
 *
 * Uses a mocked Supabase client to test IDOR handling and response structure.
 */

import { describe, it, expect } from "vitest";
import { getCaseDetail } from "@/server/cases/get";

// ── Mock helpers ──────────────────────────────────────────────────────────────

type MockResult = { data: unknown; error: { code: string } | null };
type ArrayResult = { data: unknown[]; error: null };

/**
 * Build a chainable mock that resolves to `finalResult` on any terminal call
 * (single, limit, or when awaited directly via .then).
 */
function makeChainable(finalResult: MockResult | ArrayResult) {
  const chain: Record<string, unknown> = {};
  chain["select"] = () => chain;
  chain["eq"] = () => chain;
  chain["order"] = () => chain;
  chain["limit"] = () => Promise.resolve(finalResult);
  chain["single"] = () => Promise.resolve(finalResult);
  // Allow the chain itself to be awaited (for queries without .single()/.limit())
  chain["then"] = (resolve: (v: typeof finalResult) => void) =>
    Promise.resolve(finalResult).then(resolve);
  chain["catch"] = (reject: (e: unknown) => void) =>
    Promise.resolve(finalResult).catch(reject);
  return chain;
}

function buildDetailMock(
  caseResult: MockResult,
  extractedResult: ArrayResult,
  missingDocsResult: ArrayResult,
  auditResult: ArrayResult
) {
  const supabase = {
    from: (table: string) => {
      switch (table) {
        case "cases":
          return makeChainable(caseResult);
        case "extracted_fields":
          return makeChainable(extractedResult);
        case "missing_docs":
          return makeChainable(missingDocsResult);
        case "audit_log":
          return makeChainable(auditResult);
        default:
          return makeChainable({ data: [], error: null });
      }
    },
  };

  return supabase;
}

// ── getCaseDetail ─────────────────────────────────────────────────────────────

describe("getCaseDetail", () => {
  const mockCase = {
    id: "case-uuid-1",
    tenant_id: "tenant-1",
    status: "listo",
    claim_type: "choque",
  };

  const emptyRelated = { data: [], error: null };

  it("returns CaseDetail for an existing case", async () => {
    const supabase = buildDetailMock(
      { data: mockCase, error: null },
      emptyRelated,
      emptyRelated,
      emptyRelated
    );

    const result = await getCaseDetail(supabase, "case-uuid-1");
    expect(result).not.toBeNull();
    expect(result!.case).toEqual(mockCase);
    expect(result!.extracted_fields).toEqual([]);
    expect(result!.missing_docs).toEqual([]);
    expect(result!.audit_log).toEqual([]);
  });

  it("returns null when case is not found (IDOR prevention)", async () => {
    const supabase = buildDetailMock(
      { data: null, error: { code: "PGRST116" } },
      emptyRelated,
      emptyRelated,
      emptyRelated
    );

    const result = await getCaseDetail(supabase, "non-existent-uuid");
    // IDOR: not found or wrong tenant → null, caller returns 404 (never 403)
    expect(result).toBeNull();
  });

  it("returns null when Supabase RLS blocks the row (wrong tenant)", async () => {
    // When RLS blocks: Supabase returns error PGRST116 (no rows found)
    const supabase = buildDetailMock(
      { data: null, error: { code: "PGRST116" } },
      emptyRelated,
      emptyRelated,
      emptyRelated
    );

    const result = await getCaseDetail(supabase, "another-tenant-case");
    expect(result).toBeNull();
  });

  it("includes extracted_fields when present", async () => {
    const extractedFields = [
      { id: "ef-1", case_id: "case-uuid-1", field_key: "date", field_value: "2024-01-15", confidence: 0.95 },
      { id: "ef-2", case_id: "case-uuid-1", field_key: "location", field_value: "Av. Corrientes 1234", confidence: 0.88 },
    ];

    const supabase = buildDetailMock(
      { data: mockCase, error: null },
      { data: extractedFields, error: null },
      emptyRelated,
      emptyRelated
    );

    const result = await getCaseDetail(supabase, "case-uuid-1");
    expect(result).not.toBeNull();
    expect(result!.extracted_fields).toHaveLength(2);
    expect(result!.extracted_fields[0].field_key).toBe("date");
  });

  it("includes missing_docs when present", async () => {
    const missingDocs = [
      { id: "md-1", case_id: "case-uuid-1", doc_key: "foto_oblea_vtv" },
    ];

    const supabase = buildDetailMock(
      { data: mockCase, error: null },
      emptyRelated,
      { data: missingDocs, error: null },
      emptyRelated
    );

    const result = await getCaseDetail(supabase, "case-uuid-1");
    expect(result).not.toBeNull();
    expect(result!.missing_docs).toHaveLength(1);
    expect(result!.missing_docs[0].doc_key).toBe("foto_oblea_vtv");
  });

  it("includes audit_log when present", async () => {
    const auditEntries = [
      { id: 1, event_type: "case.status_changed", created_at: "2024-01-15T10:00:00Z" },
      { id: 2, event_type: "case.closed", created_at: "2024-01-16T12:00:00Z" },
    ];

    const supabase = buildDetailMock(
      { data: mockCase, error: null },
      emptyRelated,
      emptyRelated,
      { data: auditEntries, error: null }
    );

    const result = await getCaseDetail(supabase, "case-uuid-1");
    expect(result).not.toBeNull();
    expect(result!.audit_log).toHaveLength(2);
  });
});
