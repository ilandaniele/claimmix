/**
 * Unit tests for orchestratePostExtraction.
 *
 * All DB calls and email dispatches are mocked — no real DB or Gmail.
 *
 * AC7:  Medium-confidence field → inserts claim_field_confirmations row + logs CONFIRMATION_REQUESTED
 * AC9:  Customer conflict → sets confirmacion_pendiente + dispatches data_confirmation_request
 * AC10: Missing required fields → dispatches missing_information_request + status=info_faltante
 * AC11: High/critical severity → dispatches specialist_escalation + confirmation_received
 * AC12: confirmation_received always dispatched when is_claim=true
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { orchestratePostExtraction } from "@/server/confirmations/orchestrate";
import { extractEmailClaimMock } from "@/server/ai/mock-extractor";
import type { CustomerMatch } from "@/server/matching/customer-matcher";

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock the entire @/lib/db module — drizzle requires DATABASE_URL at init time
// which is not available in unit tests. We provide a chainable mock instead.
vi.mock("@/lib/db", () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };
  return { db: mockDb, tables: {} };
});

// Mock @/lib/db/helpers — firstRow just returns rows[0] ?? null, safe to mock.
vi.mock("@/lib/db/helpers", () => ({
  firstRow: (rows: unknown[]) => rows[0] ?? null,
  ilikeAny: vi.fn(),
  countRows: vi.fn(),
}));

// Mock dispatchOutboundEmail so no real emails are sent.
vi.mock("@/server/email/dispatch", () => ({
  dispatchOutboundEmail: vi.fn().mockResolvedValue(undefined),
}));

// Mock writeAuditLog to capture audit calls without DB.
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    SPECIALIST_REQUIRED: "claim.specialist_required",
    CONFIRMATION_REQUESTED: "claim.confirmation_requested",
    MISSING_INFO_REQUESTED: "claim.missing_info_requested",
    OUTBOUND_EMAIL_SENT: "email.outbound_sent",
    OUTBOUND_EMAIL_FAILED: "email.outbound_failed",
  },
}));

// Mock gap analyzer.
vi.mock("@/server/cases/gap-analyzer", () => ({
  analyzeEmailClaimGaps: vi.fn().mockResolvedValue({
    missingRequiredFields: [],
    fieldsNeedingConfirmation: [],
    isComplete: true,
    status: "listo_para_core",
  }),
}));

// ── Import mocked modules for assertion ──────────────────────────────────────

import { db } from "@/lib/db";
import { dispatchOutboundEmail } from "@/server/email/dispatch";
import { writeAuditLog } from "@/lib/audit/log";
import { analyzeEmailClaimGaps } from "@/server/cases/gap-analyzer";

// ── DB mock builder ───────────────────────────────────────────────────────────

type MockDb = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

// Drizzle stores the table name at Symbol.for("drizzle:Name").
const DRIZZLE_NAME = Symbol.for("drizzle:Name");

/** Extract the underlying table name from a drizzle table object. */
function getTableName(table: unknown): string {
  return (table as Record<symbol, string>)[DRIZZLE_NAME] ?? "";
}

/**
 * Configure the db mock chains for a single test.
 *
 * orchestrate.ts uses three chain patterns:
 *   1. db.select({id}).from(claimFieldConfirmations).where(...).limit(1)
 *      → returns [] (no existing row) so upsertFieldConfirmation takes the insert path
 *   2. db.select({id}).from(outboundMessages).where(...).limit(1)
 *      → controlled by outboundMessagesRows
 *   3. db.update(cases|claimFieldConfirmations).set({...}).where(...)
 *      → tracked by updateSpy
 *   4. db.insert(claimFieldConfirmations).values({...})
 *      → tracked by insertSpy
 *
 * The from() call differentiates which table by reading the drizzle
 * Symbol.for("drizzle:Name") property on the real table object.
 */
function setupDbMocks({
  outboundMessagesRows = [] as Array<{ id: string }>,
} = {}) {
  const mockDbTyped = db as MockDb;

  // Track all insert .values() and update .where() calls for assertions.
  const insertSpy = vi.fn().mockResolvedValue([]);
  const updateSpy = vi.fn().mockResolvedValue([]);

  // db.select() returns a chainable builder; from() decides the result.
  mockDbTyped.select.mockImplementation(() => ({
    from: (table: unknown) => {
      const tableName = getTableName(table);

      if (tableName === "outbound_messages") {
        return {
          where: () => ({
            limit: () => Promise.resolve(outboundMessagesRows),
          }),
        };
      }

      // claim_field_confirmations (or any other table) — return empty so upsert inserts.
      return {
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      };
    },
  }));

  // db.insert(table).values({...}) — track all inserts.
  mockDbTyped.insert.mockImplementation(() => ({
    values: insertSpy,
  }));

  // db.update(table).set({...}).where(...) — track all updates.
  mockDbTyped.update.mockImplementation(() => ({
    set: (data: unknown) => ({
      where: () => updateSpy(data),
    }),
  }));

  return { insertSpy, updateSpy };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CASE_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const TENANT_ID = "cccccccc-0000-0000-0000-000000000001";
const SENDER_EMAIL = "claimant@example.com";
const NO_MATCHES: CustomerMatch[] = [];

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Set up default DB mock chains for every test.
  setupDbMocks();

  // Reset gap analyzer to default (complete claim) for each test.
  vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({
    missingRequiredFields: [],
    fieldsNeedingConfirmation: [],
    isComplete: true,
    status: "listo_para_core",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Test suite: Non-claim — AC5 ───────────────────────────────────────────────

describe("orchestratePostExtraction — non-claim (is_claim=false)", () => {
  it("returns early without dispatching any emails when is_claim=false", async () => {
    const claim = extractEmailClaimMock({ is_claim: false });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    expect(dispatchOutboundEmail).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("does not update case status when is_claim=false", async () => {
    const claim = extractEmailClaimMock({ is_claim: false });
    const { updateSpy } = setupDbMocks();

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    // No DB update calls for non-claim.
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

// ── Test suite: High severity — AC11 + AC12 ──────────────────────────────────

describe("orchestratePostExtraction — high severity (AC11)", () => {
  it("dispatches specialist_escalation email for severity=high", async () => {
    const claim = extractEmailClaimMock({ severity: "high", requires_specialist: true });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const specialistCall = vi.mocked(dispatchOutboundEmail).mock.calls.find(
      (call) => call[0].template === "specialist_escalation"
    );
    expect(specialistCall).toBeDefined();
    expect(specialistCall?.[0].to).toBe(SENDER_EMAIL);
    expect(specialistCall?.[0].data.severity).toBe("high");
  });

  it("dispatches specialist_escalation for severity=critical", async () => {
    const claim = extractEmailClaimMock({ severity: "critical", requires_specialist: true });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const specialistCall = vi.mocked(dispatchOutboundEmail).mock.calls.find(
      (call) => call[0].template === "specialist_escalation"
    );
    expect(specialistCall).toBeDefined();
  });

  it("logs SPECIALIST_REQUIRED audit event for high severity", async () => {
    const claim = extractEmailClaimMock({ severity: "high", requires_specialist: true });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const specialistAudit = vi.mocked(writeAuditLog).mock.calls.find(
      (call) => call[0].event_type === "claim.specialist_required"
    );
    expect(specialistAudit).toBeDefined();
    expect(specialistAudit?.[0].target_id).toBe(CASE_ID);
  });

  it("sets case status to requiere_especialista for high severity", async () => {
    const claim = extractEmailClaimMock({ severity: "critical", requires_specialist: true });
    const { updateSpy } = setupDbMocks();

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    // updateSpy receives the set({...}) data object.
    const statusUpdate = updateSpy.mock.calls.find(
      (call) => (call[0] as { status?: string })?.status === "requiere_especialista"
    );
    expect(statusUpdate).toBeDefined();
  });

  it("also dispatches confirmation_received for high severity claim (AC12)", async () => {
    const claim = extractEmailClaimMock({ severity: "high", requires_specialist: true });
    setupDbMocks({ outboundMessagesRows: [] });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const confirmationCall = vi.mocked(dispatchOutboundEmail).mock.calls.find(
      (call) => call[0].template === "confirmation_received"
    );
    expect(confirmationCall).toBeDefined();
    expect(confirmationCall?.[0].to).toBe(SENDER_EMAIL);
  });
});

// ── Test suite: Medium-confidence field — AC7 ─────────────────────────────────

describe("orchestratePostExtraction — medium-confidence field (AC7)", () => {
  it("inserts claim_field_confirmations row for medium-confidence field", async () => {
    const claim = extractEmailClaimMock({
      fields_pending_confirmation: ["full_name"],
      fields: [
        ...extractEmailClaimMock().fields.filter((f) => f.field_key !== "full_name"),
        { field_key: "full_name", field_value: "Juan Pérez", confidence: 0.72, source: "ai" as const },
      ],
    });
    const { insertSpy } = setupDbMocks();

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    // insertSpy is called with the values object for the insert.
    const insertCall = insertSpy.mock.calls.find((call) => {
      const data = call[0] as { field_name?: string } | Array<{ field_name?: string }>;
      const row = Array.isArray(data) ? data[0] : data;
      return row?.field_name === "full_name";
    });
    expect(insertCall).toBeDefined();
  });

  it("logs CONFIRMATION_REQUESTED audit event for medium-confidence field", async () => {
    const claim = extractEmailClaimMock({
      fields_pending_confirmation: ["accident_date"],
      fields: [
        ...extractEmailClaimMock().fields.filter((f) => f.field_key !== "accident_date"),
        { field_key: "accident_date", field_value: "2024-03-15", confidence: 0.70, source: "ai" as const },
      ],
    });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const confirmationAudit = vi.mocked(writeAuditLog).mock.calls.find(
      (call) => call[0].event_type === "claim.confirmation_requested"
    );
    expect(confirmationAudit).toBeDefined();
    expect(confirmationAudit?.[0].payload?.field_key).toBe("accident_date");
    // PII check: the proposed value must NOT appear in the audit payload
    expect(JSON.stringify(confirmationAudit?.[0].payload)).not.toContain("2024-03-15");
  });

  it("dispatches data_confirmation_request email for pending-confirmation fields", async () => {
    const claim = extractEmailClaimMock({
      fields_pending_confirmation: ["full_name"],
      fields: [
        ...extractEmailClaimMock().fields.filter((f) => f.field_key !== "full_name"),
        { field_key: "full_name", field_value: "Juan Pérez", confidence: 0.72, source: "ai" as const },
      ],
    });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const confirmationEmailCall = vi.mocked(dispatchOutboundEmail).mock.calls.find(
      (call) => call[0].template === "data_confirmation_request"
    );
    expect(confirmationEmailCall).toBeDefined();
    expect(confirmationEmailCall?.[0].to).toBe(SENDER_EMAIL);
  });
});

// ── Test suite: Customer conflict — AC9 ──────────────────────────────────────

describe("orchestratePostExtraction — customer conflict (AC9)", () => {
  it("inserts conflict claim_field_confirmations row and sets confirmacion_pendiente", async () => {
    const claim = extractEmailClaimMock({
      fields: [
        ...extractEmailClaimMock().fields.filter((f) => f.field_key !== "full_name"),
        { field_key: "full_name", field_value: "Pedro García", confidence: 0.92, source: "ai" as const },
      ],
    });

    const conflictingMatch: CustomerMatch = {
      customerId: "cust-001",
      matchType: "email",
      confidence: 0.75,
      customerName: "Juan Pérez",
      conflictsWithExtracted: ["full_name"],
    };

    const { insertSpy, updateSpy } = setupDbMocks();

    // Make gap analyzer return confirmacion_pendiente for conflict scenario.
    vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({
      missingRequiredFields: [],
      fieldsNeedingConfirmation: [
        {
          fieldName: "full_name",
          suggestedValue: "Pedro García",
          conflictValue: "Juan Pérez",
          reason: "conflict",
        },
      ],
      isComplete: false,
      status: "confirmacion_pendiente",
    });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      [conflictingMatch]
    );

    // Confirmation row should be inserted for the conflict.
    const insertCall = insertSpy.mock.calls.find((call) => {
      const data = call[0] as { field_name?: string } | Array<{ field_name?: string }>;
      const row = Array.isArray(data) ? data[0] : data;
      return row?.field_name === "full_name";
    });
    expect(insertCall).toBeDefined();

    // Status should include confirmacion_pendiente.
    const pendingUpdate = updateSpy.mock.calls.find(
      (call) => (call[0] as { status?: string })?.status === "confirmacion_pendiente"
    );
    expect(pendingUpdate).toBeDefined();
  });

  it("dispatches data_confirmation_request email for conflict", async () => {
    const claim = extractEmailClaimMock({
      fields: [
        ...extractEmailClaimMock().fields.filter((f) => f.field_key !== "full_name"),
        { field_key: "full_name", field_value: "Pedro García", confidence: 0.92, source: "ai" as const },
      ],
    });

    const conflictingMatch: CustomerMatch = {
      customerId: "cust-002",
      matchType: "email",
      confidence: 0.75,
      customerName: "Juan Pérez",
      conflictsWithExtracted: ["full_name"],
    };

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      [conflictingMatch]
    );

    const conflictEmailCall = vi.mocked(dispatchOutboundEmail).mock.calls.find(
      (call) =>
        call[0].template === "data_confirmation_request" &&
        call[0].data?.fieldKey === "full_name"
    );
    expect(conflictEmailCall).toBeDefined();
    expect(conflictEmailCall?.[0].data?.conflictWithValue).toBe("Juan Pérez");
    expect(conflictEmailCall?.[0].data?.proposedValue).toBe("Pedro García");
  });

  it("logs CONFIRMATION_REQUESTED for conflict with reason=conflict in payload", async () => {
    const claim = extractEmailClaimMock({
      fields: [
        ...extractEmailClaimMock().fields.filter((f) => f.field_key !== "full_name"),
        { field_key: "full_name", field_value: "Pedro García", confidence: 0.92, source: "ai" as const },
      ],
    });

    const conflictingMatch: CustomerMatch = {
      customerId: "cust-003",
      matchType: "email",
      confidence: 0.75,
      customerName: "Juan Pérez",
      conflictsWithExtracted: ["full_name"],
    };

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      [conflictingMatch]
    );

    const conflictAudit = vi.mocked(writeAuditLog).mock.calls.find(
      (call) =>
        call[0].event_type === "claim.confirmation_requested" &&
        call[0].payload?.reason === "conflict"
    );
    expect(conflictAudit).toBeDefined();
    expect(conflictAudit?.[0].payload?.field_key).toBe("full_name");
  });
});

// ── Test suite: Missing required fields — AC10 ────────────────────────────────

describe("orchestratePostExtraction — missing required fields (AC10)", () => {
  it("dispatches missing_information_request when required fields are missing", async () => {
    const claim = extractEmailClaimMock();
    vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({
      missingRequiredFields: ["accident_date", "policy_number"],
      fieldsNeedingConfirmation: [],
      isComplete: false,
      status: "info_faltante",
    });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const missingEmailCall = vi.mocked(dispatchOutboundEmail).mock.calls.find(
      (call) => call[0].template === "missing_information_request"
    );
    expect(missingEmailCall).toBeDefined();
    expect(missingEmailCall?.[0].data?.missingFields).toContain("accident_date");
    expect(missingEmailCall?.[0].data?.missingFields).toContain("policy_number");
  });

  it("sets case status to info_faltante for missing required fields", async () => {
    const claim = extractEmailClaimMock();
    vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({
      missingRequiredFields: ["full_name"],
      fieldsNeedingConfirmation: [],
      isComplete: false,
      status: "info_faltante",
    });

    const { updateSpy } = setupDbMocks();

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const infoFaltanteUpdate = updateSpy.mock.calls.find(
      (call) => (call[0] as { status?: string })?.status === "info_faltante"
    );
    expect(infoFaltanteUpdate).toBeDefined();
  });

  it("logs MISSING_INFO_REQUESTED audit event", async () => {
    const claim = extractEmailClaimMock();
    vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({
      missingRequiredFields: ["accident_date"],
      fieldsNeedingConfirmation: [],
      isComplete: false,
      status: "info_faltante",
    });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const missingAudit = vi.mocked(writeAuditLog).mock.calls.find(
      (call) => call[0].event_type === "claim.missing_info_requested"
    );
    expect(missingAudit).toBeDefined();
    expect(missingAudit?.[0].payload?.missing_fields).toContain("accident_date");
  });

  it("includes ONLY missing fields in the email (not the full required list)", async () => {
    const claim = extractEmailClaimMock();
    vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({
      missingRequiredFields: ["accident_date"],
      fieldsNeedingConfirmation: [],
      isComplete: false,
      status: "info_faltante",
    });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const missingEmailCall = vi.mocked(dispatchOutboundEmail).mock.calls.find(
      (call) => call[0].template === "missing_information_request"
    );
    // Should only include the 1 missing field — not the full required list
    const missingFields = missingEmailCall?.[0].data?.missingFields as string[];
    expect(missingFields).toBeDefined();
    expect(missingFields).toHaveLength(1);
    expect(missingFields[0]).toBe("accident_date");
  });
});

// ── Test suite: Complete claim → listo_para_core ──────────────────────────────

describe("orchestratePostExtraction — complete claim", () => {
  it("sets case status to listo_para_core when gap analysis returns complete", async () => {
    const claim = extractEmailClaimMock();
    const { updateSpy } = setupDbMocks();

    // Default mock: listo_para_core
    vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({
      missingRequiredFields: [],
      fieldsNeedingConfirmation: [],
      isComplete: true,
      status: "listo_para_core",
    });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const coreUpdate = updateSpy.mock.calls.find(
      (call) => (call[0] as { status?: string })?.status === "listo_para_core"
    );
    expect(coreUpdate).toBeDefined();
  });

  it("does NOT dispatch missing_information_request for complete claim", async () => {
    const claim = extractEmailClaimMock();

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const missingEmailCall = vi.mocked(dispatchOutboundEmail).mock.calls.find(
      (call) => call[0].template === "missing_information_request"
    );
    expect(missingEmailCall).toBeUndefined();
  });
});

// ── Test suite: AC12 — confirmation_received always sent ─────────────────────

describe("orchestratePostExtraction — confirmation_received (AC12)", () => {
  it("dispatches confirmation_received for any is_claim=true case", async () => {
    const claim = extractEmailClaimMock();
    setupDbMocks({ outboundMessagesRows: [] });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const confirmationCall = vi.mocked(dispatchOutboundEmail).mock.calls.find(
      (call) => call[0].template === "confirmation_received"
    );
    expect(confirmationCall).toBeDefined();
    expect(confirmationCall?.[0].caseId).toBe(CASE_ID);
    expect(confirmationCall?.[0].to).toBe(SENDER_EMAIL);
  });

  it("does NOT dispatch confirmation_received if already sent (idempotency)", async () => {
    const claim = extractEmailClaimMock();
    // Simulate existing confirmation_received outbound_messages row.
    setupDbMocks({ outboundMessagesRows: [{ id: "existing-msg-id" }] });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const confirmationCalls = vi.mocked(dispatchOutboundEmail).mock.calls.filter(
      (call) => call[0].template === "confirmation_received"
    );
    expect(confirmationCalls).toHaveLength(0);
  });

  it("dispatches confirmation_received even for medium-severity claim", async () => {
    const claim = extractEmailClaimMock({ severity: "medium" });
    setupDbMocks({ outboundMessagesRows: [] });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const confirmationCall = vi.mocked(dispatchOutboundEmail).mock.calls.find(
      (call) => call[0].template === "confirmation_received"
    );
    expect(confirmationCall).toBeDefined();
  });

  it("confirmation_received email body references caseId and not DNI (AC24 contract)", async () => {
    const claim = extractEmailClaimMock();
    setupDbMocks({ outboundMessagesRows: [] });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const confirmationCall = vi.mocked(dispatchOutboundEmail).mock.calls.find(
      (call) => call[0].template === "confirmation_received"
    );
    // The data passed to dispatchOutboundEmail must contain caseId
    expect(confirmationCall?.[0].data?.caseId).toBe(CASE_ID);
    // DNI must NOT appear in the data object passed to the dispatcher
    const dataStr = JSON.stringify(confirmationCall?.[0].data ?? {});
    expect(dataStr).not.toMatch(/\b\d{7,8}\b/); // no raw DNI
  });
});

// ── Test suite: checkConfirmationAlreadySent error branches ───────────────────
// These tests cover the DB error and catch branches in checkConfirmationAlreadySent
// by configuring the db.select mock to return an error or throw.

describe("orchestratePostExtraction — checkConfirmationAlreadySent error paths", () => {
  it("sends confirmation_received when outbound_messages DB check throws (fail open)", async () => {
    const claim = extractEmailClaimMock();

    const mockDbTyped = db as MockDb;

    // Override select to throw for outbound_messages queries.
    mockDbTyped.select.mockImplementation(() => ({
      from: (table: unknown) => {
        const tableName = getTableName(table);
        if (tableName === "outbound_messages") {
          return {
            where: () => ({
              limit: () => Promise.reject(new Error("DB connection lost")),
            }),
          };
        }
        // claim_field_confirmations — return empty (no existing row).
        return {
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        };
      },
    }));

    mockDbTyped.insert.mockImplementation(() => ({
      values: vi.fn().mockResolvedValue([]),
    }));

    mockDbTyped.update.mockImplementation(() => ({
      set: () => ({
        where: vi.fn().mockResolvedValue([]),
      }),
    }));

    // Should not throw — catch block returns false (fail open).
    await expect(
      orchestratePostExtraction(
        CASE_ID,
        TENANT_ID,
        { extractedClaim: claim, senderEmail: SENDER_EMAIL },
        NO_MATCHES
      )
    ).resolves.toBeUndefined();

    // Fail open: confirmation_received dispatched.
    const confirmationCall = vi.mocked(dispatchOutboundEmail).mock.calls.find(
      (call) => call[0].template === "confirmation_received"
    );
    expect(confirmationCall).toBeDefined();
  });

  it("sends confirmation_received when outbound_messages check returns empty (no error path)", async () => {
    // This covers the normal path where DB returns no rows — email is dispatched.
    const claim = extractEmailClaimMock();
    setupDbMocks({ outboundMessagesRows: [] });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const confirmationCall = vi.mocked(dispatchOutboundEmail).mock.calls.find(
      (call) => call[0].template === "confirmation_received"
    );
    expect(confirmationCall).toBeDefined();
  });
});

// ── Test suite: getStoredFieldValue non-full_name branch ──────────────────────
// When fieldKey is NOT "full_name", getStoredFieldValue returns "".
// This is exercised when a conflict is detected on a non-full_name field (e.g. "email").

describe("orchestratePostExtraction — getStoredFieldValue non-full_name field", () => {
  it("handles email field conflict without conflict_with_value (non-full_name → '')", async () => {
    const claim = extractEmailClaimMock({
      fields: [
        ...extractEmailClaimMock().fields.filter((f) => f.field_key !== "email"),
        { field_key: "email", field_value: "other@example.com", confidence: 0.92, source: "ai" as const },
      ],
    });

    const conflictOnEmail: CustomerMatch = {
      customerId: "cust-004",
      matchType: "email",
      confidence: 0.75,
      customerName: "Ana García",
      conflictsWithExtracted: ["email"], // non-full_name conflict
    };

    const { insertSpy } = setupDbMocks();

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      [conflictOnEmail]
    );

    // Confirm that a confirmation row was inserted for the email field.
    const emailConflictInsert = insertSpy.mock.calls.find((call) => {
      const data = call[0] as { field_name?: string } | Array<{ field_name?: string }>;
      const row = Array.isArray(data) ? data[0] : data;
      return row?.field_name === "email";
    });
    expect(emailConflictInsert).toBeDefined();

    // conflict_with_value should be "" for non-full_name fields (getStoredFieldValue fallback).
    const insertData = emailConflictInsert?.[0] as
      | { conflict_with_value?: string }
      | Array<{ conflict_with_value?: string }>;
    const row = Array.isArray(insertData) ? insertData[0] : insertData;
    expect(row?.conflict_with_value ?? "").toBe("");
  });
});
