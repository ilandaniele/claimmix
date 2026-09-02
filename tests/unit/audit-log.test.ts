/**
 * Unit tests for audit log writer — mocks the Drizzle db instance.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @/lib/db before importing writeAuditLog (hoisted by Vitest).
const mockValues = vi.fn();
// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: hay tests que
// intercambian la base simulada entre casos, y un `const { db } = ...`
// congelaría el valor de la primera.
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
    insert: vi.fn(() => ({ values: mockValues })),
  },
}));

import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { db } from "@/lib/db";

describe("writeAuditLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.insert).mockReturnValue({ values: mockValues } as unknown as ReturnType<typeof db.insert>);
    mockValues.mockResolvedValue({ rowCount: 1 });
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

    expect(db.insert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith(
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

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: null,
        target_type: null,
        target_id: null,
        ip: null,
        ua: null,
      })
    );
  });

  it("does not throw when db.insert throws", async () => {
    vi.mocked(db.insert).mockImplementation(() => {
      throw new Error("db connection error");
    });

    // Audit log failures must never break the request flow.
    await expect(
      writeAuditLog({
        tenant_id: "10000000-0000-0000-0000-000000000001",
        event_type: "auth.failure",
      })
    ).resolves.toBeUndefined();
  });

  it("does not throw when db.insert returns a rejected promise", async () => {
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockRejectedValue(new Error("neon error")),
    } as unknown as ReturnType<typeof db.insert>);

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

    expect(mockValues).toHaveBeenCalledWith(
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
