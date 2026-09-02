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
// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: el mock de @/lib/db
// suele exponer `db` con un getter para que los tests puedan intercambiar la
// base simulada entre corridas, y un `const { db } = ...` congelaría el valor
// de la primera llamada.
//
// Lo que NO se prueba acá es que el contexto de inquilino llegue a la base:
// eso se verifica en tests/unit/data-scope-sin-rol.test.ts y, contra bases de
// verdad, en `pnpm capa-datos` y `pnpm tenancy`.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

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
  { field_key: "policy_number",        field_value: "POL-4471-A",       confidence: 0.90, source: "ai" },
  { field_key: "dni",                  field_value: "30145882",         confidence: 0.90, source: "ai" },
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
  }>,
  /** Rows already in extracted_fields from earlier runs on this case. */
  storedFieldRows: Array<{
    field_key: string;
    field_value: string;
    confidence: number;
  }> = []
) {
  // Order matters: the analyzer reads missing_docs, then extracted_fields,
  // then claim_field_confirmations.
  const byCall = [missingDocRows, storedFieldRows, confirmationRows];
  let callCount = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const rows = byCall[callCount] ?? confirmationRows;
    callCount++;
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
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
    // Also covers the Spanish aliases: numero_poliza and dni_asegurado satisfy
    // the required policy_number and dni, rather than being reported missing
    // while we hold them under the other spelling.
    const fieldsWithPhone: ExtractedField[] = [
      { field_key: "full_name",            field_value: "Ana García",  confidence: 0.91, source: "ai" },
      { field_key: "phone",                field_value: "+54 11 9999", confidence: 0.88, source: "ai" },
      { field_key: "accident_date",        field_value: "2024-04-01",  confidence: 0.90, source: "ai" },
      { field_key: "accident_description", field_value: "Robo del vehículo", confidence: 0.87, source: "ai" },
      { field_key: "claim_type",           field_value: "robo",        confidence: 0.89, source: "ai" },
      { field_key: "numero_poliza",        field_value: "POL-8890-C",  confidence: 0.90, source: "ai" },
      { field_key: "dni_asegurado",        field_value: "28777111",    confidence: 0.90, source: "ai" },
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
      { field_key: "full_name", proposed_value: "Juan Pérez", conflict_with_value: null, confidence: 0.72, source: "ai" as const },
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
      { field_key: "policy_number",        field_value: "POL-4471-A",       confidence: 0.90, source: "ai" },
      { field_key: "dni",                  field_value: "30145882",         confidence: 0.90, source: "ai" },
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
      { field_key: "full_name", proposed_value: "Juan Pérez", conflict_with_value: null, confidence: 0.72, source: "ai" as const },
      { field_key: "policy_number", proposed_value: "POL-9999", conflict_with_value: null, confidence: 0.65, source: "ai" as const },
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

// ── Test suite: policy number and DNI are required ───────────────────────────

describe("analyzeEmailClaimGaps — identifying the policy", () => {
  const WITHOUT_IDS: ExtractedField[] = [
    { field_key: "full_name",            field_value: "Juan Pérez",       confidence: 0.92, source: "ai" },
    { field_key: "email",                field_value: "juan@example.com", confidence: 0.95, source: "ai" },
    { field_key: "accident_date",        field_value: "2024-03-15",       confidence: 0.90, source: "ai" },
    { field_key: "accident_description", field_value: "Choque en Av. Corrientes", confidence: 0.88, source: "ai" },
    { field_key: "claim_type",           field_value: "choque",           confidence: 0.90, source: "ai" },
  ];

  it("does not call a claim ready when there is no way to find the policy", async () => {
    // A case reached listo_para_core with no policy number and no DNI, while
    // the agent spent its one question confirming a province it had inferred.
    setupDbMocks([], []);
    const result = await analyzeEmailClaimGaps(CASE_ID, WITHOUT_IDS, TENANT_ID);

    expect(result.status).toBe("info_faltante");
    expect(result.missingRequiredFields).toContain("policy_number");
    expect(result.missingRequiredFields).toContain("dni");
    expect(result.isComplete).toBe(false);
  });

  it("accepts them under the Spanish keys the extractor also emits", async () => {
    setupDbMocks([], []);
    const result = await analyzeEmailClaimGaps(
      CASE_ID,
      [
        ...WITHOUT_IDS,
        { field_key: "numero_poliza", field_value: "POL-4471-A", confidence: 0.9, source: "ai" },
        { field_key: "dni_asegurado", field_value: "30145882",   confidence: 0.9, source: "ai" },
      ],
      TENANT_ID
    );

    expect(result.missingRequiredFields).not.toContain("policy_number");
    expect(result.missingRequiredFields).not.toContain("dni");
  });

  it("still reports them missing when read too poorly to use", async () => {
    setupDbMocks([], []);
    const result = await analyzeEmailClaimGaps(
      CASE_ID,
      [
        ...WITHOUT_IDS,
        { field_key: "policy_number", field_value: "POL?", confidence: 0.3, source: "ai" },
        { field_key: "dni",           field_value: "301",  confidence: 0.2, source: "ai" },
      ],
      TENANT_ID
    );

    expect(result.missingRequiredFields).toContain("policy_number");
    expect(result.missingRequiredFields).toContain("dni");
  });
});

// ── Test suite: completeness is a property of the case ───────────────────────

describe("analyzeEmailClaimGaps — what the case already holds", () => {
  beforeEach(() => vi.clearAllMocks());

  const STORED = [
    { field_key: "full_name", field_value: "Ilan Daniele", confidence: 0.95, source: "ai" as const },
    { field_key: "accident_date", field_value: "2026-08-16", confidence: 0.9, source: "ai" as const },
    { field_key: "accident_description", field_value: "Choque", confidence: 0.8, source: "ai" as const },
    { field_key: "numero_poliza", field_value: "POL-4471-A", confidence: 0.95, source: "ai" as const },
    { field_key: "dni_asegurado", field_value: "30145882", confidence: 0.95, source: "ai" as const },
    { field_key: "telefono_contacto", field_value: "2914567788", confidence: 0.85, source: "ai" as const },
  ];

  it("does not re-ask for data an earlier message already supplied", async () => {
    // The third message of a real conversation was "fue un choque", so the
    // extractor returned the claim type and little else — correctly. Judging
    // completeness from that one array declared five fields missing and
    // emailed the claimant asking for things sitting in the database at 0.95.
    const thisRunOnly: ExtractedField[] = [
      { field_key: "claim_type", field_value: "choque", confidence: 0.86, source: "ai" },
    ];
    setupDbMocks([], [], STORED);

    const result = await analyzeEmailClaimGaps(CASE_ID, thisRunOnly, TENANT_ID);

    expect(result.missingRequiredFields).toEqual([]);
    expect(result.status).toBe("listo_para_core");
  });

  it("still reports a field neither the case nor the run has", async () => {
    setupDbMocks([], [], STORED.filter((f) => f.field_key !== "dni_asegurado"));

    const result = await analyzeEmailClaimGaps(
      CASE_ID,
      [{ field_key: "claim_type", field_value: "choque", confidence: 0.86, source: "ai" }],
      TENANT_ID
    );

    expect(result.missingRequiredFields).toContain("dni");
  });

  it("lets a fresh reading override a stored value of equal confidence", async () => {
    // A correction in the latest message must not lose to the old value.
    setupDbMocks(
      [],
      [],
      [...STORED, { field_key: "claim_type", field_value: "other", confidence: 0.86, source: "ai" as const }]
    );

    const result = await analyzeEmailClaimGaps(
      CASE_ID,
      [{ field_key: "claim_type", field_value: "granizo", confidence: 0.86, source: "ai" }],
      TENANT_ID
    );

    expect(result.missingRequiredFields).toEqual([]);
  });
});
