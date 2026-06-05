import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateServiceClient,
  mockRunEmailExtractionWorker,
  mockWriteAuditLog,
} = vi.hoisted(() => ({
  mockCreateServiceClient: vi.fn(),
  mockRunEmailExtractionWorker: vi.fn(),
  mockWriteAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mockCreateServiceClient,
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

function makeSingleResult<T>(data: T) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data, error: null }),
  };
}

describe("runIntakeAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEmailExtractionWorker.mockResolvedValue(undefined);
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  it("chooses WhatsApp extraction for whatsapp cases", async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "cases") {
          return makeSingleResult({
            id: "case-001",
            tenant_id: "tenant-001",
            channel: "whatsapp",
            status: "recibido",
          });
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    mockCreateServiceClient.mockReturnValue(supabase);

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
});

describe("createWhatsAppIntakeAndRunAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEmailExtractionWorker.mockResolvedValue(undefined);
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  it("stores a WhatsApp message and runs the intake agent", async () => {
    const inserts: Record<string, unknown>[] = [];
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "cases") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            insert: vi.fn((payload: Record<string, unknown>) => {
              inserts.push({ table, payload });
              return {
                select: vi.fn().mockReturnThis(),
                single: vi.fn().mockResolvedValue({
                  data: { id: "case-whatsapp-001" },
                  error: null,
                }),
              };
            }),
            single: vi.fn().mockResolvedValue({
              data: {
                id: "case-whatsapp-001",
                tenant_id: "tenant-001",
                channel: "whatsapp",
                status: "recibido",
              },
              error: null,
            }),
          };
        }

        if (table === "claim_messages" || table === "raw_messages") {
          return {
            insert: vi.fn((payload: Record<string, unknown>) => {
              inserts.push({ table, payload });
              return Promise.resolve({ error: null });
            }),
          };
        }

        throw new Error(`Unexpected table ${table}`);
      }),
    };
    mockCreateServiceClient.mockReturnValue(supabase);

    const result = await createWhatsAppIntakeAndRunAgent({
      tenantId: "tenant-001",
      from: "+5491112345678",
      body: "Tuve un choque el 27/07/2025. Siniestro 91500000-2.",
      providerMessageId: "wamid-001",
    });

    expect(result.caseId).toBe("case-whatsapp-001");
    expect(result.created).toBe(true);
    expect(result.agent.action).toBe("extract_whatsapp");
    expect(inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "claim_messages",
          payload: expect.objectContaining({
            provider: "whatsapp",
            from_addr: "+5491112345678",
            body_text: expect.stringContaining("choque"),
          }),
        }),
        expect.objectContaining({
          table: "raw_messages",
          payload: expect.objectContaining({
            channel: "whatsapp",
            body: expect.stringContaining("Siniestro"),
          }),
        }),
      ])
    );
    expect(mockRunEmailExtractionWorker).toHaveBeenCalledWith(
      "case-whatsapp-001",
      "tenant-001",
      null
    );
  });
});
