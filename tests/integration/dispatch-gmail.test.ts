/**
 * Integration tests for dispatchOutboundEmail — W5.
 *
 * AC4: Outbound send writes provider_message_id to claim_messages.
 *   GIVEN a case C with an inbound message whose provider_message_id='in-1'
 *   WHEN dispatchOutboundEmail({ caseId: C.id, template: 'confirmation-received', ... }) is called
 *   AND the EmailProvider.send mock returns { providerMessageId: 'out-1' }
 *   THEN a claim_messages row exists with direction='outbound', status='sent',
 *        provider_message_id='out-1', in_reply_to='in-1', template='confirmation-received'
 *   AND audit_log row with event_type='OUTBOUND_EMAIL_SENT' and payload.provider_message_id='out-1'
 *
 * AC5: Outbound failure marks status='failed' and does not throw.
 *   GIVEN EmailProvider.send mock returns { errorCode: 'GMAIL_SEND_FAILED' }
 *   WHEN dispatchOutboundEmail is called
 *   THEN the promise resolves (no throw)
 *   AND claim_messages row has status='failed' and error_code='GMAIL_SEND_FAILED'
 *   AND audit_log row with event_type='OUTBOUND_EMAIL_FAILED' and payload.error='GMAIL_SEND_FAILED'
 *
 * AC16: Outbound headers include In-Reply-To and References when threading.
 *   GIVEN dispatchOutboundEmail({ ..., inReplyToMessageId: 'in-1' }) is called
 *   THEN provider.send() receives headers with In-Reply-To: 'in-1' and References: 'in-1'
 *
 * Uses setEmailProvider() / resetEmailProvider() DI from W2 to inject a mock provider.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    OUTBOUND_EMAIL_SENT: "email.outbound_sent",
    OUTBOUND_EMAIL_FAILED: "email.outbound_failed",
  },
}));

// ── Constants ─────────────────────────────────────────────────────────────────

const CASE_ID = "case-uuid-w5-001";
const TENANT_ID = "tenant-w5-001";
const TO_ADDR = "claimant@example.com";
const FROM_ADDR = "claims@company.com";
const CLAIM_MSG_ID = "claim-msg-uuid-out-001";
const OUTBOUND_MSG_ID = "outbound-msg-uuid-001";

// ── DB mock builder ───────────────────────────────────────────────────────────

/**
 * Track what was inserted / updated on each table.
 * Returns an inserts map + updates map for assertions.
 */
function buildServiceMock() {
  const inserts: Record<string, unknown[]> = {
    claim_messages: [],
    outbound_messages: [],
    audit_log: [],
  };

  const updates: Record<string, unknown[]> = {
    claim_messages: [],
    outbound_messages: [],
  };

  /**
   * Generic Supabase query builder chain.
   * Supports: .insert().select().single()  — returns inserted row id
   *           .update().eq()               — records update args
   */
  function makeTableMock(
    tableName: string,
    insertedId: string,
  ) {
    return {
      insert: (row: unknown) => {
        const rows = Array.isArray(row) ? row : [row];
        inserts[tableName].push(...rows);

        return {
          select: () => ({
            single: () =>
              Promise.resolve({ data: { id: insertedId }, error: null }),
          }),
          single: () =>
            Promise.resolve({ data: { id: insertedId }, error: null }),
        };
      },

      update: (patch: unknown) => {
        // Capture the update payload — the .eq() call follows
        const pending = { patch };
        return {
          eq: (col: string, val: unknown) => {
            updates[tableName].push({ ...pending, where: { [col]: val } });
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };
  }

  const mock = {
    _inserts: inserts,
    _updates: updates,

    from: vi.fn().mockImplementation((table: string) => {
      if (table === "claim_messages") {
        return makeTableMock("claim_messages", CLAIM_MSG_ID);
      }
      if (table === "outbound_messages") {
        return makeTableMock("outbound_messages", OUTBOUND_MSG_ID);
      }
      // fallback
      return {
        insert: (row: unknown) => {
          const rows = Array.isArray(row) ? row : [row];
          (inserts[table] = inserts[table] ?? []).push(...rows);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: "fallback-id" }, error: null }),
            }),
          };
        },
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      };
    }),
  };

  return mock;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("dispatchOutboundEmail — W5 (claim_messages dual-write)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GMAIL_FROM_ADDRESS = FROM_ADDR;
    process.env.DEFAULT_TENANT_ID = TENANT_ID;
  });

  afterEach(async () => {
    delete process.env.GMAIL_FROM_ADDRESS;
    delete process.env.DEFAULT_TENANT_ID;

    // Reset provider singleton so mock doesn't bleed between tests.
    const { resetEmailProvider } = await import("@/server/email/gmail/index");
    resetEmailProvider();
  });

  // ── AC4 ─────────────────────────────────────────────────────────────────────

  it("AC4: inserts claim_messages row with direction=outbound, status=queued before send", async () => {
    const mockSend = vi.fn().mockResolvedValue({ providerMessageId: "out-1" });
    const { setEmailProvider } = await import("@/server/email/gmail/index");
    setEmailProvider({ name: "gmail", send: mockSend });

    const dbMock = buildServiceMock();
    const { createServiceClient } = await import("@/lib/supabase/service");
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);

    const { dispatchOutboundEmail } = await import("@/server/email/dispatch");
    await dispatchOutboundEmail({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: TO_ADDR,
      template: "confirmation_received",
      data: { caseId: CASE_ID },
      inReplyToMessageId: "in-1",
    });

    const cmInserts = dbMock._inserts["claim_messages"];
    expect(cmInserts.length).toBe(1);

    const row = cmInserts[0] as Record<string, unknown>;
    expect(row.direction).toBe("outbound");
    expect(row.provider).toBe("gmail");
    expect(row.status).toBe("queued");
    expect(row.provider_message_id).toBeNull();
    expect(row.in_reply_to).toBe("in-1");
    expect(row.template).toBe("confirmation_received");
    expect(row.tenant_id).toBe(TENANT_ID);
    expect(row.case_id).toBe(CASE_ID);
    expect(row.to_addr).toBe(TO_ADDR);
    expect(row.from_addr).toBe(FROM_ADDR);
  });

  it("AC4: updates claim_messages with provider_message_id=out-1 and status=sent on success", async () => {
    const mockSend = vi.fn().mockResolvedValue({ providerMessageId: "out-1" });
    const { setEmailProvider } = await import("@/server/email/gmail/index");
    setEmailProvider({ name: "gmail", send: mockSend });

    const dbMock = buildServiceMock();
    const { createServiceClient } = await import("@/lib/supabase/service");
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);

    const { dispatchOutboundEmail } = await import("@/server/email/dispatch");
    await dispatchOutboundEmail({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: TO_ADDR,
      template: "confirmation_received",
      data: { caseId: CASE_ID },
      inReplyToMessageId: "in-1",
    });

    const cmUpdates = dbMock._updates["claim_messages"];
    expect(cmUpdates.length).toBe(1);

    const update = cmUpdates[0] as { patch: Record<string, unknown>; where: Record<string, unknown> };
    expect(update.patch.provider_message_id).toBe("out-1");
    expect(update.patch.status).toBe("sent");
    expect(update.patch.sent_at).toBeDefined();
    expect(update.where.id).toBe(CLAIM_MSG_ID);
  });

  it("AC4: audit_log contains OUTBOUND_EMAIL_SENT with provider_message_id=out-1", async () => {
    const mockSend = vi.fn().mockResolvedValue({ providerMessageId: "out-1" });
    const { setEmailProvider } = await import("@/server/email/gmail/index");
    setEmailProvider({ name: "gmail", send: mockSend });

    const dbMock = buildServiceMock();
    const { createServiceClient } = await import("@/lib/supabase/service");
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);

    const { writeAuditLog } = await import("@/lib/audit/log");

    const { dispatchOutboundEmail } = await import("@/server/email/dispatch");
    await dispatchOutboundEmail({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: TO_ADDR,
      template: "confirmation_received",
      data: { caseId: CASE_ID },
      inReplyToMessageId: "in-1",
    });

    expect(writeAuditLog).toHaveBeenCalledOnce();
    const auditCall = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(auditCall.event_type).toBe("email.outbound_sent");
    const payload = auditCall.payload as Record<string, unknown>;
    expect(payload.provider_message_id).toBe("out-1");
  });

  it("AC4: dispatch returns { providerMessageId: 'out-1' } on success", async () => {
    const mockSend = vi.fn().mockResolvedValue({ providerMessageId: "out-1" });
    const { setEmailProvider } = await import("@/server/email/gmail/index");
    setEmailProvider({ name: "gmail", send: mockSend });

    const dbMock = buildServiceMock();
    const { createServiceClient } = await import("@/lib/supabase/service");
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);

    const { dispatchOutboundEmail } = await import("@/server/email/dispatch");
    const result = await dispatchOutboundEmail({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: TO_ADDR,
      template: "confirmation_received",
      data: { caseId: CASE_ID },
      inReplyToMessageId: "in-1",
    });

    expect(result).toEqual({ providerMessageId: "out-1" });
  });

  // ── AC5 ─────────────────────────────────────────────────────────────────────

  it("AC5: promise resolves (does not throw) when provider.send returns errorCode", async () => {
    const mockSend = vi.fn().mockResolvedValue({ errorCode: "GMAIL_SEND_FAILED" });
    const { setEmailProvider } = await import("@/server/email/gmail/index");
    setEmailProvider({ name: "gmail", send: mockSend });

    const dbMock = buildServiceMock();
    const { createServiceClient } = await import("@/lib/supabase/service");
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);

    const { dispatchOutboundEmail } = await import("@/server/email/dispatch");

    // Must not throw — await should settle, not reject.
    await expect(
      dispatchOutboundEmail({
        caseId: CASE_ID,
        tenantId: TENANT_ID,
        to: TO_ADDR,
        template: "confirmation_received",
        data: { caseId: CASE_ID },
      })
    ).resolves.toBeDefined();
  });

  it("AC5: returns { error: 'GMAIL_SEND_FAILED' } on failure", async () => {
    const mockSend = vi.fn().mockResolvedValue({ errorCode: "GMAIL_SEND_FAILED" });
    const { setEmailProvider } = await import("@/server/email/gmail/index");
    setEmailProvider({ name: "gmail", send: mockSend });

    const dbMock = buildServiceMock();
    const { createServiceClient } = await import("@/lib/supabase/service");
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);

    const { dispatchOutboundEmail } = await import("@/server/email/dispatch");
    const result = await dispatchOutboundEmail({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: TO_ADDR,
      template: "confirmation_received",
      data: { caseId: CASE_ID },
    });

    expect(result).toEqual({ error: "GMAIL_SEND_FAILED" });
  });

  it("AC5: claim_messages row has status=failed and error_code=GMAIL_SEND_FAILED", async () => {
    const mockSend = vi.fn().mockResolvedValue({ errorCode: "GMAIL_SEND_FAILED" });
    const { setEmailProvider } = await import("@/server/email/gmail/index");
    setEmailProvider({ name: "gmail", send: mockSend });

    const dbMock = buildServiceMock();
    const { createServiceClient } = await import("@/lib/supabase/service");
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);

    const { dispatchOutboundEmail } = await import("@/server/email/dispatch");
    await dispatchOutboundEmail({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: TO_ADDR,
      template: "confirmation_received",
      data: { caseId: CASE_ID },
    });

    const cmUpdates = dbMock._updates["claim_messages"];
    expect(cmUpdates.length).toBe(1);

    const update = cmUpdates[0] as { patch: Record<string, unknown>; where: Record<string, unknown> };
    expect(update.patch.status).toBe("failed");
    expect(update.patch.error_code).toBe("GMAIL_SEND_FAILED");
    expect(update.where.id).toBe(CLAIM_MSG_ID);
  });

  it("AC5: audit_log contains OUTBOUND_EMAIL_FAILED with payload.error=GMAIL_SEND_FAILED", async () => {
    const mockSend = vi.fn().mockResolvedValue({ errorCode: "GMAIL_SEND_FAILED" });
    const { setEmailProvider } = await import("@/server/email/gmail/index");
    setEmailProvider({ name: "gmail", send: mockSend });

    const dbMock = buildServiceMock();
    const { createServiceClient } = await import("@/lib/supabase/service");
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);

    const { writeAuditLog } = await import("@/lib/audit/log");

    const { dispatchOutboundEmail } = await import("@/server/email/dispatch");
    await dispatchOutboundEmail({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: TO_ADDR,
      template: "confirmation_received",
      data: { caseId: CASE_ID },
    });

    expect(writeAuditLog).toHaveBeenCalledOnce();
    const auditCall = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(auditCall.event_type).toBe("email.outbound_failed");
    const payload = auditCall.payload as Record<string, unknown>;
    expect(payload.error).toBe("GMAIL_SEND_FAILED");
  });

  // ── AC16 ────────────────────────────────────────────────────────────────────

  it("AC16: provider.send receives In-Reply-To and References headers when inReplyToMessageId is set", async () => {
    const mockSend = vi.fn().mockResolvedValue({ providerMessageId: "out-1" });
    const { setEmailProvider } = await import("@/server/email/gmail/index");
    setEmailProvider({ name: "gmail", send: mockSend });

    const dbMock = buildServiceMock();
    const { createServiceClient } = await import("@/lib/supabase/service");
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);

    const { dispatchOutboundEmail } = await import("@/server/email/dispatch");
    await dispatchOutboundEmail({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: TO_ADDR,
      template: "confirmation_received",
      data: { caseId: CASE_ID },
      inReplyToMessageId: "in-1",
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const sendOpts = mockSend.mock.calls[0][0] as Record<string, unknown>;
    const headers = sendOpts.headers as Array<{ Name: string; Value: string }>;

    expect(Array.isArray(headers)).toBe(true);
    expect(headers).toContainEqual({ Name: "In-Reply-To", Value: "in-1" });
    expect(headers).toContainEqual({ Name: "References", Value: "in-1" });
  });

  it("AC16: provider.send receives no headers array when inReplyToMessageId is not set", async () => {
    const mockSend = vi.fn().mockResolvedValue({ providerMessageId: "out-2" });
    const { setEmailProvider } = await import("@/server/email/gmail/index");
    setEmailProvider({ name: "gmail", send: mockSend });

    const dbMock = buildServiceMock();
    const { createServiceClient } = await import("@/lib/supabase/service");
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);

    const { dispatchOutboundEmail } = await import("@/server/email/dispatch");
    await dispatchOutboundEmail({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: TO_ADDR,
      template: "confirmation_received",
      data: { caseId: CASE_ID },
      // no inReplyToMessageId
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const sendOpts = mockSend.mock.calls[0][0] as Record<string, unknown>;
    // When no threading, headers should be undefined (not an empty array)
    expect(sendOpts.headers).toBeUndefined();
  });

  // ── Dual-write guard (outbound_messages still written) ───────────────────────

  it("outbound_messages row is also inserted (dual-write window preserved)", async () => {
    const mockSend = vi.fn().mockResolvedValue({ providerMessageId: "out-1" });
    const { setEmailProvider } = await import("@/server/email/gmail/index");
    setEmailProvider({ name: "gmail", send: mockSend });

    const dbMock = buildServiceMock();
    const { createServiceClient } = await import("@/lib/supabase/service");
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);

    const { dispatchOutboundEmail } = await import("@/server/email/dispatch");
    await dispatchOutboundEmail({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: TO_ADDR,
      template: "confirmation_received",
      data: { caseId: CASE_ID },
    });

    const omInserts = dbMock._inserts["outbound_messages"];
    expect(omInserts.length).toBe(1);

    const row = omInserts[0] as Record<string, unknown>;
    expect(row.case_id).toBe(CASE_ID);
    expect(row.status).toBe("queued");
    expect(row.template).toBe("confirmation_received");
  });

  it("outbound_messages row updated to status=sent on provider success", async () => {
    const mockSend = vi.fn().mockResolvedValue({ providerMessageId: "out-1" });
    const { setEmailProvider } = await import("@/server/email/gmail/index");
    setEmailProvider({ name: "gmail", send: mockSend });

    const dbMock = buildServiceMock();
    const { createServiceClient } = await import("@/lib/supabase/service");
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);

    const { dispatchOutboundEmail } = await import("@/server/email/dispatch");
    await dispatchOutboundEmail({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: TO_ADDR,
      template: "confirmation_received",
      data: { caseId: CASE_ID },
    });

    const omUpdates = dbMock._updates["outbound_messages"];
    expect(omUpdates.length).toBe(1);

    const update = omUpdates[0] as { patch: Record<string, unknown>; where: Record<string, unknown> };
    expect(update.patch.status).toBe("sent");
    expect(update.where.id).toBe(OUTBOUND_MSG_ID);
  });

  it("outbound_messages row updated to status=failed on provider error", async () => {
    const mockSend = vi.fn().mockResolvedValue({ errorCode: "GMAIL_SEND_FAILED" });
    const { setEmailProvider } = await import("@/server/email/gmail/index");
    setEmailProvider({ name: "gmail", send: mockSend });

    const dbMock = buildServiceMock();
    const { createServiceClient } = await import("@/lib/supabase/service");
    (createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(dbMock);

    const { dispatchOutboundEmail } = await import("@/server/email/dispatch");
    await dispatchOutboundEmail({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
      to: TO_ADDR,
      template: "confirmation_received",
      data: { caseId: CASE_ID },
    });

    const omUpdates = dbMock._updates["outbound_messages"];
    expect(omUpdates.length).toBe(1);

    const update = omUpdates[0] as { patch: Record<string, unknown>; where: Record<string, unknown> };
    expect(update.patch.status).toBe("failed");
    expect(update.where.id).toBe(OUTBOUND_MSG_ID);
  });
});
