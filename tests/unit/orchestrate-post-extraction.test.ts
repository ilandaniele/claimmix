/**
 * Unit tests for orchestratePostExtraction.
 *
 * All DB calls and email dispatches are mocked — no real DB or Gmail.
 *
 * AC7:  Medium-confidence field → inserts claim_field_confirmations row + logs CONFIRMATION_REQUESTED
 * AC9:  Customer conflict → sets confirmacion_pendiente + dispatches data_confirmation_request
 * AC10: Missing required fields → dispatches missing_information_request + status=info_faltante
 * AC11: High/critical severity → dispatches specialist_escalation (no confirmation_received)
 * AC12: confirmation_received dispatched when is_claim=true and not escalated
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
  // Real value: the orchestrator resolves pending confirmations against the
  // same threshold the analyzer uses to create them.
  MEDIUM_CONFIDENCE_HIGH: 0.85,
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

  it("does NOT pile a generic confirmation on top of the escalation", async () => {
    // The escalation email already acknowledges receipt, gives the case number
    // and promises a specialist within 24h. Adding "recibimos tu denuncia"
    // sends a third simultaneous email to someone who just reported a fire,
    // and it says strictly less than the one they already have.
    const claim = extractEmailClaimMock({ severity: "high", requires_specialist: true });
    setupDbMocks({ outboundMessagesRows: [] });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const templates = vi
      .mocked(dispatchOutboundEmail)
      .mock.calls.map((call) => call[0].template);

    expect(templates).toContain("specialist_escalation");
    expect(templates).not.toContain("confirmation_received");
  });

  it("still acknowledges receipt — the escalation email is the acknowledgement", async () => {
    // Suppressing the confirmation must not leave the claimant with silence.
    const claim = extractEmailClaimMock({ severity: "critical", requires_specialist: true });
    setupDbMocks({ outboundMessagesRows: [] });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const escalation = vi
      .mocked(dispatchOutboundEmail)
      .mock.calls.find((call) => call[0].template === "specialist_escalation");

    expect(escalation).toBeDefined();
    expect(escalation?.[0].to).toBe(SENDER_EMAIL);
    expect(escalation?.[0].data.caseId).toBe(CASE_ID);
  });
});

// ── Test suite: Medium-confidence field — AC7 ─────────────────────────────────

describe("orchestratePostExtraction — medium-confidence field (AC7)", () => {
  it("asks even when only the gap analyzer thinks the field is uncertain", async () => {
    // The bug this covers, seen in production: the gap analyzer put the case in
    // confirmacion_pendiente because claim_type came back at 0.60, but the
    // extractor left fields_pending_confirmation empty, so no email went out.
    // The board read "waiting on the claimant" about a question nobody asked,
    // and the case would have sat there forever.
    const claim = extractEmailClaimMock({
      fields_pending_confirmation: [],
      fields: [
        ...extractEmailClaimMock().fields.filter((f) => f.field_key !== "claim_type"),
        { field_key: "claim_type", field_value: "other", confidence: 0.6, source: "ai" as const },
      ],
    });
    vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({
      missingRequiredFields: [],
      fieldsNeedingConfirmation: [
        { fieldName: "claim_type", suggestedValue: "other", reason: "medium_confidence" },
      ],
      isComplete: false,
      status: "confirmacion_pendiente",
    });
    const { updateSpy } = setupDbMocks();

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const ask = vi
      .mocked(dispatchOutboundEmail)
      .mock.calls.find((c) => c[0].template === "missing_information_request");
    expect(ask).toBeDefined();
    expect(ask?.[0].data.missingFields).toContain("claim_type");

    // And the status it lands in must be one the sent email justifies.
    const pending = updateSpy.mock.calls.find(
      (c) => (c[0] as { status?: string })?.status === "confirmacion_pendiente"
    );
    expect(pending).toBeDefined();
  });

  it("closes a pending confirmation once the claimant has answered it", async () => {
    // The loop this breaks: a pending row is written when a field is
    // uncertain, the gap analyzer reads pending rows back out as "needs
    // confirmation", and the orchestrator re-asks and rewrites the row as
    // pending. A claimant who replied "fue un choque" — lifting claim_type
    // from 0.70 to 0.90 — was asked to confirm "choque de vehículo", the thing
    // they had just said, and would have been asked again after answering.
    const claim = extractEmailClaimMock({
      fields_pending_confirmation: [],
      fields: [
        ...extractEmailClaimMock().fields.filter((f) => f.field_key !== "claim_type"),
        { field_key: "claim_type", field_value: "choque", confidence: 0.9, source: "ai" as const },
      ],
    });
    const { updateSpy } = setupDbMocks();

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const resolved = updateSpy.mock.calls.find(
      (c) => (c[0] as { status?: string })?.status === "confirmed"
    );
    expect(resolved).toBeDefined();
  });

  it("leaves a field still in the uncertain band pending", async () => {
    // Nothing in this extraction clears the bar, so nothing gets closed.
    const claim = extractEmailClaimMock({
      fields_pending_confirmation: [],
      fields: extractEmailClaimMock().fields.map((f) => ({ ...f, confidence: 0.7 })),
    });
    const { updateSpy } = setupDbMocks();

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const resolved = updateSpy.mock.calls.find(
      (c) => (c[0] as { status?: string })?.status === "confirmed"
    );
    expect(resolved).toBeUndefined();
  });

  it("never asks someone to confirm the sentence they wrote", async () => {
    // A real email did this: Campo "Qué pasó", quoting back the claimant's own
    // words. Free text is the one thing that needs no confirming.
    const base = extractEmailClaimMock().fields.filter(
      (f) => f.field_key !== "accident_description"
    );
    const claim = extractEmailClaimMock({
      fields_pending_confirmation: ["accident_description", "descripcion_hecho"],
      fields: [
        ...base,
        {
          field_key: "accident_description",
          field_value: "Tuve un problema con el auto anteayer",
          confidence: 0.7,
          source: "ai" as const,
        },
      ],
    });
    setupDbMocks();

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const ask = vi
      .mocked(dispatchOutboundEmail)
      .mock.calls.find((c) => c[0].template === "data_confirmation_request");
    expect(ask).toBeUndefined();
  });

  it("asks about the classification before anything it merely read", async () => {
    // This model hands back whole groups at exactly 0.70, so ordering by
    // confidence decided nothing and the tie fell to emission order. claim_type
    // is the only field we deduced, and the required documents hang off it.
    const base = extractEmailClaimMock().fields.filter(
      (f) => f.field_key !== "claim_type" && f.field_key !== "accident_location"
    );
    const claim = extractEmailClaimMock({
      fields_pending_confirmation: ["accident_location"],
      fields: [
        ...base,
        { field_key: "accident_location", field_value: "Bahía Blanca", confidence: 0.7, source: "ai" as const },
        { field_key: "claim_type", field_value: "other", confidence: 0.7, source: "ai" as const },
      ],
    });
    vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({
      missingRequiredFields: [],
      fieldsNeedingConfirmation: [
        { fieldName: "claim_type", suggestedValue: "other", reason: "medium_confidence" },
      ],
      isComplete: false,
      status: "confirmacion_pendiente",
    });

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const ask = vi
      .mocked(dispatchOutboundEmail)
      .mock.calls.find((c) => c[0].template === "missing_information_request");
    const asked = ask?.[0].data.missingFields as string[];
    expect(asked[0]).toBe("claim_type");
  });

  it("writes one row when the same field arrives under two spellings", async () => {
    // `phone` and `telefono_contacto` carry the same number in the same
    // extraction. Two rows means two questions about one thing.
    const base = extractEmailClaimMock().fields.filter((f) => f.field_key !== "phone");
    const claim = extractEmailClaimMock({
      fields_pending_confirmation: ["phone", "telefono_contacto"],
      fields: [
        ...base,
        { field_key: "phone", field_value: "+598 99 413 456", confidence: 0.7, source: "ai" as const },
        { field_key: "telefono_contacto", field_value: "+598 99 413 456", confidence: 0.8, source: "ai" as const },
      ],
    });
    const { insertSpy } = setupDbMocks();

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const rows = insertSpy.mock.calls
      .map((c) => (Array.isArray(c[0]) ? c[0][0] : c[0]) as { field_name?: string })
      .filter((r) => r?.field_name === "phone" || r?.field_name === "telefono_contacto");
    expect(rows).toHaveLength(1);
    expect(rows[0].field_name).toBe("phone");
  });

  it("does not stack a confirmation request on top of a missing-info request", async () => {
    // Two "necesitamos algo tuyo" emails arriving together is the same pile-up
    // removed from the escalation path. The row is still written — the
    // uncertainty stays on the record for the analyst.
    const claim = extractEmailClaimMock({
      fields_pending_confirmation: ["claim_type"],
      fields: [
        ...extractEmailClaimMock().fields.filter((f) => f.field_key !== "claim_type"),
        { field_key: "claim_type", field_value: "other", confidence: 0.7, source: "ai" as const },
      ],
    });
    vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({
      missingRequiredFields: ["accident_date"],
      fieldsNeedingConfirmation: [],
      isComplete: false,
      status: "info_faltante",
    });
    const { insertSpy } = setupDbMocks();

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const templates = vi.mocked(dispatchOutboundEmail).mock.calls.map((c) => c[0].template);
    expect(templates).toContain("missing_information_request");
    expect(templates).not.toContain("data_confirmation_request");

    const row = insertSpy.mock.calls
      .map((c) => (Array.isArray(c[0]) ? c[0][0] : c[0]) as { field_name?: string })
      .find((r) => r?.field_name === "claim_type");
    expect(row).toBeDefined();
  });

  it("does not call a case ready while an unanswered question is in flight", async () => {
    const claim = extractEmailClaimMock({
      fields_pending_confirmation: ["full_name"],
      fields: [
        ...extractEmailClaimMock().fields.filter((f) => f.field_key !== "full_name"),
        { field_key: "full_name", field_value: "J. Pérez", confidence: 0.7, source: "ai" as const },
      ],
    });
    // The analyzer ran before the email existed, so on its own it says ready.
    vi.mocked(analyzeEmailClaimGaps).mockResolvedValue({
      missingRequiredFields: [],
      fieldsNeedingConfirmation: [],
      isComplete: true,
      status: "listo_para_core",
    });
    const { updateSpy } = setupDbMocks();

    await orchestratePostExtraction(
      CASE_ID,
      TENANT_ID,
      { extractedClaim: claim, senderEmail: SENDER_EMAIL },
      NO_MATCHES
    );

    const ready = updateSpy.mock.calls.find(
      (c) => (c[0] as { status?: string })?.status === "listo_para_core"
    );
    expect(ready).toBeUndefined();
  });

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

  it("asks about an uncertain field in the same email as everything else", async () => {
    // Gaps and doubts used to go out as separate emails on separate rounds.
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

    const emails = vi.mocked(dispatchOutboundEmail).mock.calls;
    const ask = emails.find((c) => c[0].template === "missing_information_request");
    expect(ask).toBeDefined();
    expect(ask?.[0].to).toBe(SENDER_EMAIL);
    expect(ask?.[0].data.missingFields).toContain("full_name");
    // The value we hold goes with it, so we ask them to correct it rather than
    // to supply something they already sent.
    expect((ask?.[0].data.knownValues as Record<string, string>).full_name).toBe(
      "Juan Pérez"
    );
    // One email, not two.
    expect(emails).toHaveLength(1);
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
