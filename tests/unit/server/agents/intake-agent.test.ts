import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------- hoisted mocks ----------
const {
  mockRunEmailExtractionWorker,
  mockWriteAuditLog,
  mockDbSelect,
  mockDbInsert,
} = vi.hoisted(() => ({
  mockRunEmailExtractionWorker: vi.fn(),
  mockWriteAuditLog: vi.fn(),
  // select chain: .select().from().where().orderBy().limit()
  mockDbSelect: vi.fn(),
  // insert chain: .insert().values().returning()
  mockDbInsert: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => {
  // Chainable select builder.
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  };
  mockDbSelect.mockReturnValue(selectChain);

  // Chainable insert builder.
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
    // insert().values() without .returning() is also called (for claimMessages, rawMessages)
    // so values() itself needs to be awaitable when not followed by returning().
    // We handle this by making returning() resolve and also making the chain thenable.
    then: undefined as unknown,
  };
  // Make insertChain.values also directly awaitable (Promise-like) for inserts without .returning().
  const valuesChain = {
    returning: vi.fn().mockResolvedValue([]),
  };
  // We'll override per-test; provide a sensible default.
  insertChain.values.mockReturnValue(valuesChain);
  mockDbInsert.mockReturnValue(insertChain);

  return {
    db: {
      select: (...args: unknown[]) => mockDbSelect(...args),
      insert: (...args: unknown[]) => mockDbInsert(...args),
    },
    tables: {
      cases: {
        id: "id",
        tenant_id: "tenant_id",
        channel: "channel",
        status: "status",
        email_thread_id: "email_thread_id",
        created_at: "created_at",
      },
      claimMessages: {},
      rawMessages: {},
    },
  };
});

vi.mock("@/lib/db/helpers", () => ({
  firstRow: <T>(rows: T[]): T | null => rows[0] ?? null,
}));

vi.mock("@/server/worker/extract", () => ({
  runEmailExtractionWorker: mockRunEmailExtractionWorker,
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockWriteAuditLog,
  AuditEvent: {
    EMAIL_RECEIVED: "email.received",
  },
}));

import {
  createWhatsAppIntakeAndRunAgent,
  runIntakeAgent,
} from "@/server/agents/intake-agent";

// ---------- helpers to configure the select chain ----------
function getSelectChain() {
  // Re-retrieve the chain object from the mock's return value.
  return mockDbSelect.mock.results[0]?.value as {
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
  } | undefined;
}

/**
 * Configure the select chain so that its terminal .limit() call resolves
 * with different results based on call order.
 *
 * selectResults[0] is returned on the first .limit() call,
 * selectResults[1] on the second, etc.
 */
function setupSelectResults(results: unknown[][]) {
  // Each call to db.select() returns a new chain with its own .limit() mock.
  // We configure db.select to return a fresh chain each invocation.
  let callIndex = 0;
  mockDbSelect.mockImplementation(() => {
    const resultRows = results[callIndex] ?? [];
    callIndex++;
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(resultRows),
    };
  });
}

/**
 * Configure db.insert so each invocation returns a chain whose
 * .values().returning() resolves with the provided rows.
 * insertConfigs is an array of { rows, rejectWith } indexed by call order.
 */
function setupInsertResults(
  insertConfigs: Array<{ rows?: unknown[]; rejectWith?: Error }>
) {
  let callIndex = 0;
  mockDbInsert.mockImplementation(() => {
    const cfg = insertConfigs[callIndex] ?? { rows: [] };
    callIndex++;
    const returningMock = cfg.rejectWith
      ? vi.fn().mockRejectedValue(cfg.rejectWith)
      : vi.fn().mockResolvedValue(cfg.rows ?? []);
    const valuesMock = vi.fn().mockReturnValue({
      returning: returningMock,
    });
    // Also make values() itself awaitable (no .returning() call).
    const valuesResult = { returning: returningMock };
    // When the code does: await db.insert(t).values({...})  (no .returning())
    // the chain needs to be a thenable. We add a then() so it resolves.
    (valuesResult as unknown as Promise<unknown[]>).then = (resolve: (v: unknown[]) => unknown) =>
      Promise.resolve(cfg.rows ?? []).then(resolve);
    valuesMock.mockReturnValue(valuesResult);
    return { values: valuesMock };
  });
}

// ---------- tests ----------
describe("runIntakeAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEmailExtractionWorker.mockResolvedValue(undefined);
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  it("chooses WhatsApp extraction for whatsapp cases", async () => {
    setupSelectResults([
      [{ id: "case-001", tenant_id: "tenant-001", channel: "whatsapp", status: "recibido" }],
    ]);

    const result = await runIntakeAgent({
      caseId: "case-001",
      tenantId: "tenant-001",
      source: "whatsapp",
    });

    expect(result.action).toBe("extract_whatsapp");
    expect(result.ok).toBe(true);
    expect(mockRunEmailExtractionWorker).toHaveBeenCalledWith("case-001", "tenant-001", null);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "intake.agent_decision",
        payload: expect.objectContaining({
          channel: "whatsapp",
          action: "extract_whatsapp",
        }),
      })
    );
  });

  it("chooses email extraction for email cases", async () => {
    setupSelectResults([
      [{ id: "case-002", tenant_id: "tenant-001", channel: "email", status: "recibido" }],
    ]);

    const result = await runIntakeAgent({
      caseId: "case-002",
      tenantId: "tenant-001",
      source: "gmail",
    });

    expect(result.action).toBe("extract_email");
    expect(result.ok).toBe(true);
    expect(mockRunEmailExtractionWorker).toHaveBeenCalledWith("case-002", "tenant-001", null);
  });

  it("chooses email extraction for email_sim cases", async () => {
    setupSelectResults([
      [{ id: "case-sim-001", tenant_id: "tenant-001", channel: "email_sim", status: "procesando" }],
    ]);

    const result = await runIntakeAgent({
      caseId: "case-sim-001",
      tenantId: "tenant-001",
      userId: "user-001",
      source: "simulate",
    });

    expect(result.action).toBe("extract_email");
    expect(result.ok).toBe(true);
    expect(mockRunEmailExtractionWorker).toHaveBeenCalledWith("case-sim-001", "tenant-001", "user-001");
  });

  it("returns case_not_found when db returns no rows", async () => {
    setupSelectResults([[]]);

    const result = await runIntakeAgent({
      caseId: "missing-case",
      tenantId: "tenant-001",
    });

    expect(result.ok).toBe(false);
    expect(result.action).toBe("case_not_found");
    expect(mockRunEmailExtractionWorker).not.toHaveBeenCalled();
  });

  it("returns case_not_found when db throws", async () => {
    mockDbSelect.mockImplementation(() => {
      throw new Error("db error");
    });

    const result = await runIntakeAgent({
      caseId: "case-err",
      tenantId: "tenant-001",
    });

    expect(result.ok).toBe(false);
    expect(result.action).toBe("case_not_found");
  });
});

describe("createWhatsAppIntakeAndRunAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEmailExtractionWorker.mockResolvedValue(undefined);
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  it("stores a new WhatsApp case and message, then runs the intake agent", async () => {
    // select calls in order:
    //   1. findExistingWhatsAppCase → [] (no existing case)
    //   2. runIntakeAgent (case lookup) → the newly created case row
    setupSelectResults([
      [], // findExistingWhatsAppCase returns nothing
      [{ id: "case-whatsapp-001", tenant_id: "tenant-001", channel: "whatsapp", status: "recibido" }],
    ]);

    // insert calls in order:
    //   1. createWhatsAppCase (cases insert .returning({id})) → [{id}]
    //   2. insertWhatsAppMessage — claimMessages insert (no .returning())
    //   3. insertWhatsAppMessage — rawMessages insert (no .returning())
    setupInsertResults([
      { rows: [{ id: "case-whatsapp-001" }] }, // cases insert
      { rows: [] },                              // claimMessages insert
      { rows: [] },                              // rawMessages insert
    ]);

    const result = await createWhatsAppIntakeAndRunAgent({
      tenantId: "tenant-001",
      from: "+5491112345678",
      body: "Tuve un choque el 27/07/2025. Siniestro 91500000-2.",
      providerMessageId: "wamid-001",
    });

    expect(result.caseId).toBe("case-whatsapp-001");
    expect(result.created).toBe(true);
    expect(result.agent.action).toBe("extract_whatsapp");
    expect(mockRunEmailExtractionWorker).toHaveBeenCalledWith(
      "case-whatsapp-001",
      "tenant-001",
      null
    );

    // Verify inserts were made (cases, claimMessages, rawMessages).
    expect(mockDbInsert).toHaveBeenCalledTimes(3);

    // Verify the claimMessages insert had the right payload.
    const claimMsgValuesCall = mockDbInsert.mock.results[1].value.values.mock.calls[0][0];
    expect(claimMsgValuesCall).toMatchObject({
      provider: "whatsapp",
      from_addr: "+5491112345678",
      body_text: expect.stringContaining("choque"),
    });

    // Verify the rawMessages insert had the right payload.
    const rawMsgValuesCall = mockDbInsert.mock.results[2].value.values.mock.calls[0][0];
    expect(rawMsgValuesCall).toMatchObject({
      channel: "whatsapp",
      body: expect.stringContaining("Siniestro"),
    });
  });

  it("reuses an existing WhatsApp case thread instead of creating a new one", async () => {
    // select calls in order:
    //   1. findExistingWhatsAppCase → existing case id
    //   2. runIntakeAgent case lookup → case row
    setupSelectResults([
      [{ id: "case-existing-001" }],
      [{ id: "case-existing-001", tenant_id: "tenant-001", channel: "whatsapp", status: "recibido" }],
    ]);

    // Only 2 inserts: claimMessages + rawMessages (no cases insert since case exists)
    setupInsertResults([
      { rows: [] }, // claimMessages
      { rows: [] }, // rawMessages
    ]);

    const result = await createWhatsAppIntakeAndRunAgent({
      tenantId: "tenant-001",
      from: "+5491112345678",
      body: "Follow-up message.",
    });

    expect(result.caseId).toBe("case-existing-001");
    expect(result.created).toBe(false);
    expect(result.agent.action).toBe("extract_whatsapp");
    // cases insert should NOT have been called.
    expect(mockDbInsert).toHaveBeenCalledTimes(2);
  });
});

describe("createWhatsAppIntake — simulated numbers never reach WhatsApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEmailExtractionWorker.mockResolvedValue(undefined);
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  /** The row handed to the first cases insert. */
  function insertedCase(): Record<string, unknown> | undefined {
    const chain = mockDbInsert.mock.results[0]?.value as
      | { values: ReturnType<typeof vi.fn> }
      | undefined;
    return chain?.values.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  }

  it("marks a simulated intake as whatsapp_sim", async () => {
    // The simulation and BSP paths invent their phone numbers. They used to be
    // safe only because the route never asked for a reply; the orchestrator
    // answers every case now, so the case itself has to carry the warning.
    setupSelectResults([
      [],
      [{ id: "case-sim-1", tenant_id: "tenant-001", channel: "whatsapp_sim", status: "recibido" }],
    ]);
    setupInsertResults([{ rows: [{ id: "case-sim-1" }] }, { rows: [] }, { rows: [] }]);

    await createWhatsAppIntakeAndRunAgent({
      tenantId: "tenant-001",
      from: "5491100000000",
      body: "Choque simulado",
      simulated: true,
    });

    expect(insertedCase()?.channel).toBe("whatsapp_sim");
  });

  it("leaves a real intake on the whatsapp channel", async () => {
    setupSelectResults([
      [],
      [{ id: "case-real-1", tenant_id: "tenant-001", channel: "whatsapp", status: "recibido" }],
    ]);
    setupInsertResults([{ rows: [{ id: "case-real-1" }] }, { rows: [] }, { rows: [] }]);

    await createWhatsAppIntakeAndRunAgent({
      tenantId: "tenant-001",
      from: "5491100000000",
      body: "Choqué en Bahía Blanca",
    });

    expect(insertedCase()?.channel).toBe("whatsapp");
  });
});
