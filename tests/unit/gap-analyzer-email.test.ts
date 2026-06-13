/**
 * Unit tests for analyzeEmailClaimGaps (email claim gap analyzer).
 *
 * AC7:  Medium-confidence fields appear in fieldsNeedingConfirmation.
 * AC9:  Conflict rows (from claim_field_confirmations) appear in fieldsNeedingConfirmation
 *       with conflictValue populated.
 * AC10: Missing required fields drive status='info_faltante'.
 *
 * All DB calls are mocked via vi.mock("@/lib/db") — no real DB connection needed.
 */

// vi.mock() must be at module top level — Vitest hoists these calls.
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  tables: {},
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { analyzeEmailClaimGaps } from "@/server/cases/gap-analyzer";
import type { ExtractedField } from "@/lib/schemas/extracted-claim";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CASE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const TENANT_ID = "bbbbbbbb-0000-0000-0000-000000000001";

/** All required fields at high confidence — no missing docs, no pending confirmations. */
const FULL_HIGH_CONFIDENCE_FIELDS: ExtractedField[] = [
  { field_key: "full_name",            field_value: "Juan Pérez",       confidence: 0.92, source: "ai" },
  { field_key: "email",                field_value: "juan@example.com", confidence: 0.95, source: "ai" },
  { field_key: "accident_date",        field_value: "2024-03-15",       confidence: 0.90, source: "ai" },
  { field_key: "accident_description", field_value: "Choque en Av. Corrientes", confidence: 0.88, source: "ai" },
  { field_key: "claim_type",           field_value: "choque",           confidence: 0.90, source: "ai" },
];

/**
 * Configure db.select mock for two sequential calls:
 *   1st call → missing_docs (returns missingDocRows)
 *   2nd call → claim_field_confirmations (returns confirmationRows)
 */
function setupDbMocks(
  missingDocRows: Array<{ doc_key: string }>,
  confirmationRows: Array<{
    field_key: string;
    proposed_value: string | null;
    conflict_with_value: string | null;
    confidence: number;
  }>
) {
  let callCount = 0;
  vi.mocked(db.select).mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // missing_docs query: db.select({doc_key:...}).from(...).where(and(...))
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(missingDocRows),
        }),
      } as any;
    }
    // claim_field_confirmations query: db.select({...}).from(...).where(and(...))
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(confirmationRows),
      }),
    } as any;
  });
}

// ── Test suite: Complete claim → listo_para_core ──────────────────────────────

describe("analyzeEmailClaimGaps — complete claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns listo_para_core when all required fields are present at high confidence", async () => {
    setupDbMocks([], []);
    const result = await analyzeEmailClaimGaps(CASE_ID, FULL_HIGH_CONFIDENCE_FIELDS, TENANT_ID);

    expect(result.status).toBe("listo_para_core");
    expect(result.isComplete).toBe(true);
    expect(result.missingRequiredFields).toHaveLength(0);
    expect(result.fieldsNeedingConfirmation).toHaveLength(0);
  });

  it("phone is accepted as contact alternative when email is absent", async () => {
    const fieldsWithPhone: ExtractedField[] = [
      { field_key: "full_name",            field_value: "Ana García",  confidence: 0.91, source: "ai" },
      { field_key: "phone",                field_value: "+54 11 9999", confidence: 0.88, source: "ai" },
      { field_key: "accident_date",        field_value: "2024-04-01",  confidence: 0.90, source: "ai" },
      { field_key: "accident_description", field_value: "Robo del vehículo", confidence: 0.87, source: "ai" },
      { field_key: "claim_type",           field_value: "robo",        confidence: 0.89, source: "ai" },
    ];
    setupDbMocks([], []);
    const result = await analyzeEmailClaimGaps(CASE_ID, fieldsWithPhone, TENANT_ID);

    expect(result.status).toBe("listo_para_core");
    expect(result.isComplete).toBe(true);
  });
});

// ── Test suite: Missing required field → info_faltante ───────────────────────

describe("analyzeEmailClaimGaps — missing required field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns info_faltante when accident_date is absent", async () => {
    const fieldsNoDate: ExtractedField[] = [
      { field_key: "full_name",            field_value: "Juan Pérez",       confidence: 0.92, source: "ai" },
      { field_key: "email",                field_value: "juan@example.com", confidence: 0.95, source: "ai" },
      { field_key: "accident_description", field_value: "Choque en calle",  confidence: 0.88, source: "ai" },
      { field_key: "claim_type",           field_value: "choque",           confidence: 0.90, source: "ai" },
    ];
    setupDbMocks([], []);
    const result = await analyzeEmailClaimGaps(CASE_ID, fieldsNoDate, TENANT_ID);

    expect(result.status).toBe("info_faltante");
    expect(result.isComplete).toBe(false);
    expect(result.missingRequiredFields).toContain("accident_date");
  });

  it("returns info_faltante when accident_date is in missing_docs (still unresolved)", async () => {
    // Test the case where fields are absent:
    const fieldsNoDate: ExtractedField[] = FULL_HIGH_CONFIDENCE_FIELDS.filter(
      (f) => f.field_key !== "accident_date"
    );
    setupDbMocks([{ doc_key: "accident_date" }], []);
    const result2 = await analyzeEmailClaimGaps(CASE_ID, fieldsNoDate, TENANT_ID);
    expect(result2.status).toBe("info_faltante");
    expect(result2.missingRequiredFields).toContain("accident_date");
  });

  it("returns info_faltante when full_name is missing", async () => {
    const fieldsNoName: ExtractedField[] = FULL_HIGH_CONFIDENCE_FIELDS.filter(
      (f) => f.field_key !== "full_name"
    );
    setupDbMocks([], []);
    const result = await analyzeEmailClaimGaps(CASE_ID, fieldsNoName, TENANT_ID);

    expect(result.status).toBe("info_faltante");
    expect(result.missingRequiredFields).toContain("full_name");
  });

  it("returns info_faltante when contact (email + phone) both absent", async () => {
    const fieldsNoContact: ExtractedField[] = FULL_HIGH_CONFIDENCE_FIELDS.filter(
      (f) => f.field_key !== "email" && f.field_key !== "phone"
    );
    setupDbMocks([], []);
    const result = await analyzeEmailClaimGaps(CASE_ID, fieldsNoContact, TENANT_ID);

    expect(result.status).toBe("info_faltante");
    // email_or_phone missing-contact sentinel is included
    expect(result.missingRequiredFields.some((f) => f === "email_or_phone" || f === "email" || f === "phone")).toBe(true);
  });

  it("info_faltante takes priority over pending confirmations", async () => {
    const fieldsNoDate: ExtractedField[] = FULL_HIGH_CONFIDENCE_FIELDS.filter(
      (f) => f.field_key !== "accident_date"
    );
    // Also have a pending confirmation
    const confirmationRows = [
      { field_key: "full_name", proposed_value: "Juan Pérez", conflict_with_value: null, confidence: 0.72 },
    ];
    setupDbMocks([], confirmationRows);
    const result = await analyzeEmailClaimGaps(CASE_ID, fieldsNoDate, TENANT_ID);

    // info_faltante > confirmacion_pendiente
    expect(result.status).toBe("info_faltante");
  });
});

// ── Test suite: Pending confirmation → confirmacion_pendiente ─────────────────

describe("analyzeEmailClaimGaps — pending confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns confirmacion_pendiente when claim_field_confirmations has a pending row", async () => {
    const confirmationRows = [
      {
        field_key: "full_name",
        proposed_value: "Juan Pérez",
        conflict_with_value: null,
        confidence: 0.72,
      },
    ];
    setupDbMocks([], confirmationRows);
    const result = await analyzeEmailClaimGaps(CASE_ID, FULL_HIGH_CONFIDENCE_FIELDS, TENANT_ID);

    expect(result.status).toBe("confirmacion_pendiente");
    expect(result.isComplete).toBe(false);
    expect(result.fieldsNeedingConfirmation).toHaveLength(1);
    expect(result.fieldsNeedingConfirmation[0].fieldName).toBe("full_name");
    expect(result.fieldsNeedingConfirmation[0].suggestedValue).toBe("Juan Pérez");
  });

  it("returns confirmacion_pendiente for medium-confidence extracted field (no DB row yet)", async () => {
    // full_name at 0.72 confidence — medium, not in confirmations table yet
    const fieldsWithMediumConfidence: ExtractedField[] = [
      { field_key: "full_name",            field_value: "Juan Pérez",       confidence: 0.72, source: "ai" },
      { field_key: "email",                field_value: "juan@example.com", confidence: 0.95, source: "ai" },
      { field_key: "accident_date",        field_value: "2024-03-15",       confidence: 0.90, source: "ai" },
      { field_key: "accident_description", field_value: "Choque en calle",  confidence: 0.88, source: "ai" },
      { field_key: "claim_type",           field_value: "choque",           confidence: 0.90, source: "ai" },
    ];
    setupDbMocks([], []);
    const result = await analyzeEmailClaimGaps(CASE_ID, fieldsWithMediumConfidence, TENANT_ID);

    expect(result.status).toBe("confirmacion_pendiente");
    const nameConfirmation = result.fieldsNeedingConfirmation.find(
      (f) => f.fieldName === "full_name"
    );
    expect(nameConfirmation).toBeDefined();
    expect(nameConfirmation?.reason).toBe("medium_confidence");
  });

  it("lists multiple pending confirmation fields", async () => {
    const confirmationRows = [
      { field_key: "full_name", proposed_value: "Juan Pérez", conflict_with_value: null, confidence: 0.72 },
      { field_key: "policy_number", proposed_value: "POL-9999", conflict_with_value: null, confidence: 0.65 },
    ];
    setupDbMocks([], confirmationRows);
    const result = await analyzeEmailClaimGaps(CASE_ID, FULL_HIGH_CONFIDENCE_FIELDS, TENANT_ID);

    expect(result.status).toBe("confirmacion_pendiente");
    expect(result.fieldsNeedingConfirmation.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Test suite: Conflict rows — AC9 ──────────────────────────────────────────

describe("analyzeEmailClaimGaps — conflict rows (AC9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes conflictValue when claim_field_confirmations has conflict_with_value", async () => {
    const confirmationRows = [
      {
        field_key: "full_name",
        proposed_value: "Pedro García",
        conflict_with_value: "Juan Pérez",
        confidence: 0.90,
      },
    ];
    setupDbMocks([], confirmationRows);
    const result = await analyzeEmailClaimGaps(CASE_ID, FULL_HIGH_CONFIDENCE_FIELDS, TENANT_ID);

    expect(result.status).toBe("confirmacion_pendiente");
    const conflictField = result.fieldsNeedingConfirmation.find(
      (f) => f.fieldName === "full_name"
    );
    expect(conflictField).toBeDefined();
    expect(conflictField?.conflictValue).toBe("Juan Pérez");
    expect(conflictField?.suggestedValue).toBe("Pedro García");
    expect(conflictField?.reason).toBe("conflict");
  });

  it("marks reason as 'conflict' when conflict_with_value is set regardless of confidence", async () => {
    const confirmationRows = [
      {
        field_key: "full_name",
        proposed_value: "Pedro García",
        conflict_with_value: "Juan Pérez",
        confidence: 0.92, // high confidence but still a conflict
      },
    ];
    setupDbMocks([], confirmationRows);
    const result = await analyzeEmailClaimGaps(CASE_ID, FULL_HIGH_CONFIDENCE_FIELDS, TENANT_ID);

    const conflictField = result.fieldsNeedingConfirmation.find(
      (f) => f.fieldName === "full_name"
    );
    expect(conflictField?.reason).toBe("conflict");
  });

  it("conflict with missing required field still returns info_faltante", async () => {
    const fieldsNoDate: ExtractedField[] = FULL_HIGH_CONFIDENCE_FIELDS.filter(
      (f) => f.field_key !== "accident_date"
    );
    const confirmationRows = [
      {
        field_key: "full_name",
        proposed_value: "Pedro García",
        conflict_with_value: "Juan Pérez",
        confidence: 0.90,
      },
    ];
    setupDbMocks([], confirmationRows);
    const result = await analyzeEmailClaimGaps(CASE_ID, fieldsNoDate, TENANT_ID);

    // info_faltante takes priority over conflict confirmations
    expect(result.status).toBe("info_faltante");
    expect(result.missingRequiredFields).toContain("accident_date");
  });
});

// ── Test suite: DB error handling ─────────────────────────────────────────────

describe("analyzeEmailClaimGaps — error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("degrades gracefully when DB query fails (returns info_faltante for safety)", async () => {
    // Both queries reject — gap-analyzer catches errors and returns []
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue({ code: "PGRST301" }),
      }),
    } as any);

    // With no extracted fields and no DB data (error state), should handle gracefully
    const result = await analyzeEmailClaimGaps(CASE_ID, [], TENANT_ID);

    // All required fields missing → info_faltante
    expect(result.status).toBe("info_faltante");
    expect(result.isComplete).toBe(false);
  });
});
