/**
 * Unit tests for cases Zod schemas.
 */

import { describe, it, expect } from "vitest";
import { CaseQuerySchema, CasePatchSchema, ClaimTypeSchema, CaseStatusSchema } from "@/lib/schemas/cases";

describe("ClaimTypeSchema", () => {
  it("accepts all valid claim types", () => {
    const types = ["choque", "robo", "granizo", "incendio"];
    for (const t of types) {
      expect(ClaimTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it("rejects invalid claim type", () => {
    expect(ClaimTypeSchema.safeParse("inundacion").success).toBe(false);
  });
});

describe("CaseStatusSchema", () => {
  it("accepts all valid statuses", () => {
    const statuses = ["procesando", "listo", "esperando", "escalado", "cerrado"];
    for (const s of statuses) {
      expect(CaseStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it("rejects invalid status", () => {
    expect(CaseStatusSchema.safeParse("pendiente").success).toBe(false);
  });
});

describe("CaseQuerySchema", () => {
  it("accepts empty query (all defaults)", () => {
    const result = CaseQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.per_page).toBe(25);
      expect(result.data.sort).toBe("created_at");
      expect(result.data.order).toBe("desc");
    }
  });

  it("caps per_page at 100 via Zod max", () => {
    const result = CaseQuerySchema.safeParse({ per_page: "500" });
    expect(result.success).toBe(false);
  });

  it("accepts per_page of 100", () => {
    const result = CaseQuerySchema.safeParse({ per_page: "100" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.per_page).toBe(100);
    }
  });

  it("coerces per_page from string", () => {
    const result = CaseQuerySchema.safeParse({ per_page: "10" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.per_page).toBe(10);
    }
  });

  it("accepts valid status filter", () => {
    const result = CaseQuerySchema.safeParse({ status: "listo" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("listo");
    }
  });

  it("rejects invalid status filter", () => {
    const result = CaseQuerySchema.safeParse({ status: "invalid" });
    expect(result.success).toBe(false);
  });

  it("accepts valid claim type filter", () => {
    const result = CaseQuerySchema.safeParse({ type: "choque" });
    expect(result.success).toBe(true);
  });

  it("accepts valid sort column", () => {
    const result = CaseQuerySchema.safeParse({ sort: "confidence_min" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sort).toBe("confidence_min");
    }
  });

  it("rejects invalid sort column (SQL injection prevention)", () => {
    const result = CaseQuerySchema.safeParse({ sort: "id; DROP TABLE cases" });
    expect(result.success).toBe(false);
  });

  it("rejects page=0", () => {
    const result = CaseQuerySchema.safeParse({ page: "0" });
    expect(result.success).toBe(false);
  });

  it("truncates q at 200 chars", () => {
    const longQ = "a".repeat(201);
    const result = CaseQuerySchema.safeParse({ q: longQ });
    expect(result.success).toBe(false);
  });

  it("accepts order=asc", () => {
    const result = CaseQuerySchema.safeParse({ order: "asc" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.order).toBe("asc");
    }
  });
});

describe("CasePatchSchema", () => {
  it("accepts a valid status update", () => {
    const result = CasePatchSchema.safeParse({ status: "cerrado", reason: "paid_out" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("cerrado");
      expect(result.data.reason).toBe("paid_out");
    }
  });

  it("accepts an assigned_to update with valid UUID", () => {
    const result = CasePatchSchema.safeParse({
      assigned_to: "20000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects assigned_to with non-UUID value", () => {
    const result = CasePatchSchema.safeParse({ assigned_to: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("accepts assigned_to as null (unassign)", () => {
    const result = CasePatchSchema.safeParse({ assigned_to: null });
    expect(result.success).toBe(true);
  });

  it("rejects empty object (at least one field required)", () => {
    const result = CasePatchSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects invalid status in patch", () => {
    const result = CasePatchSchema.safeParse({ status: "invalid_status" });
    expect(result.success).toBe(false);
  });

  it("rejects reason exceeding 500 characters", () => {
    const result = CasePatchSchema.safeParse({
      status: "cerrado",
      reason: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });
});
