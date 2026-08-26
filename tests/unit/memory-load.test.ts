/**
 * Unit tests for loadMemoryHints (smart memory loader).
 *
 * AC13: Memory hints loaded + applied in extraction worker.
 *
 * All DB calls are mocked via vi.mock("@/lib/db") — no real DB connection needed.
 */

// vi.mock() must be at module top level — Vitest hoists these calls.
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
    select: vi.fn(),
    update: vi.fn(),
  },
  tables: {
    claimMemory: {
      id: "id",
      tenant_id: "tenant_id",
      memory_type: "memory_type",
      key: "key",
      value: "value",
      confidence: "confidence",
      source: "source",
      last_used_at: "last_used_at",
    },
  },
}));

// ── Mock audit/log so writeAuditLog doesn't try to call the DB ─────────────────
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    MEMORY_APPLIED: "memory.applied",
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { loadMemoryHints } from "@/server/memory/load";

// ── Helpers ───────────────────────────────────────────────────────────────────

type MemoryRow = {
  id: string;
  memory_type: string;
  key: string;
  value: unknown;
  confidence: number;
  source: string;
  last_used_at: string | null;
};

/**
 * Configure db.select mock for loadMemoryHints.
 *
 * loadMemoryHints does:
 *   db.select({...}).from(t).where(and(...)).orderBy(...).limit(N)
 *
 * updateLastUsedAt does:
 *   db.update(t).set({...}).where(inArray(...))
 */
function setupSelectMock(rows: MemoryRow[], shouldError = false) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(
            shouldError ? (() => { throw { code: "TEST_ERROR" }; })() : rows
          ),
        }),
      }),
    }),
  } as any);

  // updateLastUsedAt: db.update(t).set({...}).where(inArray(...))
  vi.mocked(db.update).mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  } as any);
}

function setupSelectMockError() {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockRejectedValue({ code: "TEST_ERROR" }),
        }),
      }),
    }),
  } as any);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("loadMemoryHints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] when no sender identifiers provided", async () => {
    const hints = await loadMemoryHints("tenant-1");
    expect(hints).toEqual([]);
    // db.select should NOT be called — we return early
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns [] when senderEmail is empty string", async () => {
    const hints = await loadMemoryHints("tenant-1", "");
    expect(hints).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns [] when no rows found for sender", async () => {
    setupSelectMock([]);
    const hints = await loadMemoryHints("tenant-1", "unknown@example.com");
    expect(hints).toEqual([]);
  });

  it("returns hints sorted by confidence desc (highest first)", async () => {
    const rows: MemoryRow[] = [
      {
        id: "m2",
        memory_type: "field_correction",
        key: "sender@example.com",
        value: { full_name: "Juan Carlos Pérez" },
        confidence: 0.90,
        source: "human_confirmation",
        last_used_at: "2024-01-15T10:00:00Z",
      },
      {
        id: "m1",
        memory_type: "sender_profile",
        key: "sender@example.com",
        value: { full_name: "Juan Pérez" },
        confidence: 0.72,
        source: "auto_extracted",
        last_used_at: null,
      },
    ];

    // Return them high-confidence first to simulate ORDER BY confidence DESC.
    setupSelectMock(rows);

    const hints = await loadMemoryHints("tenant-1", "sender@example.com");

    expect(hints).toHaveLength(2);
    expect(hints[0].confidence).toBe(0.90);
    expect(hints[0].source).toBe("human_confirmation");
    expect(hints[1].confidence).toBe(0.72);
  });

  it("maps DB row fields to MemoryHint interface", async () => {
    const rows: MemoryRow[] = [
      {
        id: "m1",
        memory_type: "policy_link",
        key: "claimant@example.com",
        value: { policy_number: "POL-2024-001" },
        confidence: 0.85,
        source: "human_confirmation",
        last_used_at: "2024-01-10T12:00:00Z",
      },
    ];

    setupSelectMock(rows);
    const hints = await loadMemoryHints("tenant-1", "claimant@example.com");

    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({
      memoryType: "policy_link",
      key: "claimant@example.com",
      value: { policy_number: "POL-2024-001" },
      confidence: 0.85,
      source: "human_confirmation",
    });
  });

  it("AC13: logs MEMORY_APPLIED when hints returned with caseId", async () => {
    const { writeAuditLog } = await import("@/lib/audit/log");

    const rows: MemoryRow[] = [
      {
        id: "m1",
        memory_type: "sender_profile",
        key: "sender@example.com",
        value: { full_name: "Ana García" },
        confidence: 0.90,
        source: "human_confirmation",
        last_used_at: null,
      },
    ];

    setupSelectMock(rows);
    await loadMemoryHints("tenant-1", "sender@example.com", undefined, "case-abc");

    // writeAuditLog is called fire-and-forget — check after a tick to let it settle.
    await Promise.resolve();

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "memory.applied",
        target_id: "case-abc",
      })
    );
  });

  it("returns [] on DB error without throwing", async () => {
    setupSelectMockError();
    const hints = await loadMemoryHints("tenant-1", "error@example.com");
    expect(hints).toEqual([]);
  });

  it("accepts senderPhone as identifier when email not provided", async () => {
    const rows: MemoryRow[] = [
      {
        id: "m1",
        memory_type: "sender_profile",
        key: "+541112345678",
        value: { full_name: "Carlos López" },
        confidence: 0.78,
        source: "auto_extracted",
        last_used_at: null,
      },
    ];

    setupSelectMock(rows);
    const hints = await loadMemoryHints(
      "tenant-1",
      undefined,
      "+541112345678"
    );

    expect(hints).toHaveLength(1);
    expect(hints[0].key).toBe("+541112345678");
  });
});
