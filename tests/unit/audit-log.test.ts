/**
 * Unit tests for audit log writer — mocks the Supabase service client.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the service module before importing writeAuditLog.
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));

import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { createServiceClient } from "@/lib/supabase/service";

describe("writeAuditLog", () => {
  const mockInsert = vi.fn();
  const mockFrom = vi.fn(() => ({ insert: mockInsert }));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createServiceClient).mockReturnValue({
      from: mockFrom,
    } as unknown as ReturnType<typeof createServiceClient>);
    mockInsert.mockResolvedValue({ error: null });
  });

  it("inserts an audit log entry with required fields", async () => {
    await writeAuditLog({
      tenant_id: "10000000-0000-0000-0000-000000000001",
      actor_id: "20000000-0000-0000-0000-000000000001",
      event_type: AuditEvent.AUTH_SUCCESS,
      target_type: "user",
      target_id: "20000000-0000-0000-0000-000000000001",
      payload: { role: "analyst" },
      ip: "127.0.0.1",
      ua: "Mozilla/5.0",
    });

    expect(mockFrom).toHaveBeenCalledWith("audit_log");
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "10000000-0000-0000-0000-000000000001",
        actor_id: "20000000-0000-0000-0000-000000000001",
        event_type: "auth.success",
      })
    );
  });

  it("uses null defaults for optional fields", async () => {
    await writeAuditLog({
      tenant_id: "10000000-0000-0000-0000-000000000001",
      event_type: AuditEvent.AUTH_RATE_LIMITED,
    });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: null,
        target_type: null,
        target_id: null,
        ip: null,
        ua: null,
      })
    );
  });

  it("does not throw when Supabase returns an error", async () => {
    mockInsert.mockResolvedValue({
      error: { code: "PGRST301", message: "internal" },
    });

    // Should not throw — audit log failures must not break the request flow.
    await expect(
      writeAuditLog({
        tenant_id: "10000000-0000-0000-0000-000000000001",
        event_type: "auth.failure",
      })
    ).resolves.toBeUndefined();
  });

  it("does not throw when createServiceClient throws", async () => {
    vi.mocked(createServiceClient).mockImplementation(() => {
      throw new Error("service client error");
    });

    // Should not throw.
    await expect(
      writeAuditLog({
        tenant_id: "10000000-0000-0000-0000-000000000001",
        event_type: "auth.failure",
      })
    ).resolves.toBeUndefined();
  });

  it("uses empty payload object by default", async () => {
    await writeAuditLog({
      tenant_id: "10000000-0000-0000-0000-000000000001",
      event_type: AuditEvent.AUTH_SUCCESS,
    });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {},
      })
    );
  });
});

describe("AuditEvent constants", () => {
  it("has the correct string values", () => {
    expect(AuditEvent.AUTH_SUCCESS).toBe("auth.success");
    expect(AuditEvent.AUTH_FAILURE).toBe("auth.failure");
    expect(AuditEvent.AUTH_SIGN_OUT).toBe("auth.sign_out");
    expect(AuditEvent.AUTH_RATE_LIMITED).toBe("auth.rate_limited");
    expect(AuditEvent.CASE_CREATED).toBe("case.created");
    expect(AuditEvent.CASE_CLOSED).toBe("case.closed");
    expect(AuditEvent.AI_EXTRACTED).toBe("ai.extracted");
  });
});
