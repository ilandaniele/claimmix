/**
 * Unit tests for realtime utility functions.
 *
 * Tests:
 *   - formatCaseNumber: deterministic SIN-XXXX-XXXX format
 *   - mergeCaseUpdate insert: prepends, avoids duplicates
 *   - mergeCaseUpdate update: replaces in-place
 *   - computeStatusCounts: counts all statuses correctly
 */

import { formatCaseNumber, mergeCaseUpdate, computeStatusCounts } from "../../src/app/(app)/bandeja/components/casesRealtimeUtils";
import type { CaseRow } from "../../src/server/cases/list";

function makeCase(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    tenant_id: "t1",
    policy_number: "POL-001",
    policyholder_name: "Test User",
    claim_type: "choque",
    status: "listo",
    confidence_min: 0.85,
    assigned_to: null,
    channel: "email_sim",
    created_at: new Date().toISOString(),
    updated_at: null,
    closed_at: null,
    ...overrides,
  };
}

describe("formatCaseNumber", () => {
  it("returns SIN-XXXX-XXXX format", () => {
    const id = "00000000-0000-0000-0000-000000000001";
    const result = formatCaseNumber(id);
    expect(result).toMatch(/^SIN-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it("is deterministic for the same ID", () => {
    const id = "abc12345-0000-0000-0000-000000000000";
    expect(formatCaseNumber(id)).toBe(formatCaseNumber(id));
  });

  it("produces different values for different IDs", () => {
    const id1 = "00000000-0000-0000-0000-000000000001";
    const id2 = "00000000-0000-0000-0000-000000000002";
    expect(formatCaseNumber(id1)).not.toBe(formatCaseNumber(id2));
  });
});

describe("mergeCaseUpdate — insert", () => {
  it("prepends new case to empty array", () => {
    const newCase = makeCase({ id: "case-new-001" });
    const result = mergeCaseUpdate([], newCase, "insert");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("case-new-001");
  });

  it("prepends new case to front of existing array", () => {
    const existing = [makeCase({ id: "case-old-001" })];
    const newCase = makeCase({ id: "case-new-002" });
    const result = mergeCaseUpdate(existing, newCase, "insert");
    expect(result[0]!.id).toBe("case-new-002");
    expect(result[1]!.id).toBe("case-old-001");
  });

  it("does not add duplicate if case already exists", () => {
    const existing = [makeCase({ id: "case-dup-001" })];
    const dup = makeCase({ id: "case-dup-001", status: "procesando" });
    const result = mergeCaseUpdate(existing, dup, "insert");
    expect(result).toHaveLength(1);
    // Does not overwrite — insert skips duplicates
    expect(result[0]!.status).toBe("listo");
  });
});

describe("mergeCaseUpdate — update", () => {
  it("replaces the matching row in-place", () => {
    const existing = [
      makeCase({ id: "case-001", status: "procesando" }),
      makeCase({ id: "case-002", status: "listo" }),
    ];
    const updated = makeCase({ id: "case-001", status: "listo" });
    const result = mergeCaseUpdate(existing, updated, "update");
    expect(result).toHaveLength(2);
    expect(result[0]!.status).toBe("listo");
    expect(result[1]!.status).toBe("listo");
  });

  it("returns original array unchanged if case not found", () => {
    const existing = [makeCase({ id: "case-001" })];
    const notFound = makeCase({ id: "case-999", status: "cerrado" });
    const result = mergeCaseUpdate(existing, notFound, "update");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("case-001");
  });
});

describe("computeStatusCounts", () => {
  it("returns zero counts for empty array", () => {
    const counts = computeStatusCounts([]);
    expect(counts.get("todos")).toBe(0);
    expect(counts.get("listo")).toBe(0);
    expect(counts.get("procesando")).toBe(0);
    expect(counts.get("esperando")).toBe(0);
    expect(counts.get("escalado")).toBe(0);
    expect(counts.get("cerrado")).toBe(0);
  });

  it("counts each status correctly", () => {
    const cases = [
      makeCase({ status: "listo" }),
      makeCase({ status: "listo" }),
      makeCase({ status: "procesando" }),
      makeCase({ status: "esperando" }),
      makeCase({ status: "escalado" }),
      makeCase({ status: "cerrado" }),
    ];
    const counts = computeStatusCounts(cases);
    expect(counts.get("todos")).toBe(6);
    expect(counts.get("listo")).toBe(2);
    expect(counts.get("procesando")).toBe(1);
    expect(counts.get("esperando")).toBe(1);
    expect(counts.get("escalado")).toBe(1);
    expect(counts.get("cerrado")).toBe(1);
  });

  it("todos count equals total cases", () => {
    const cases = [
      makeCase({ status: "listo" }),
      makeCase({ status: "escalado" }),
      makeCase({ status: "cerrado" }),
    ];
    const counts = computeStatusCounts(cases);
    expect(counts.get("todos")).toBe(cases.length);
  });
});
