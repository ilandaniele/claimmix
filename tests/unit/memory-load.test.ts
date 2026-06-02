/**
 * Unit tests for loadMemoryHints (smart memory loader).
 *
 * AC13: Memory hints loaded + applied in extraction worker.
 *
 * All DB calls are mocked — no real Supabase connection needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadMemoryHints } from "@/server/memory/load";

// ── Mock audit/log so writeAuditLog doesn't try to call Supabase ──────────────
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    MEMORY_APPLIED: "memory.applied",
  },
}));

// ── Mock Supabase builder ─────────────────────────────────────────────────────

type MemoryRow = {
  id: string;
  memory_type: string;
  key: string;
  value: unknown;
  confidence: number;
  source: string;
  last_used_at: string | null;
};

function buildMockSupabase(rows: MemoryRow[], shouldError = false) {
  const updateMock = vi.fn().mockReturnValue({
    in: vi.fn().mockResolvedValue({ error: null }),
  });

  // Build a chainable object that resolves at .limit()
  const buildSelectChain = () => {
    const result = Promise.resolve({
      data: shouldError ? null : rows,
      error: shouldError ? { code: "TEST_ERROR" } : null,
    });
    const chain: any = {
      eq: () => chain,
      in: () => chain,
      or: () => chain,
      order: () => chain,
      limit: () => result,
    };
    return chain;
  };

  return {
    from: (table: string) => {
      if (table === "claim_memory") {
        return {
          select: () => buildSelectChain(),
          update: updateMock,
        };
      }
      return {};
    },
  } as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("loadMemoryHints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] when no sender identifiers provided", async () => {
    const supabase = buildMockSupabase([]);
    const hints = await loadMemoryHints(supabase, "tenant-1");
    expect(hints).toEqual([]);
  });

  it("returns [] when senderEmail is empty string", async () => {
    const supabase = buildMockSupabase([]);
    const hints = await loadMemoryHints(supabase, "tenant-1", "");
    expect(hints).toEqual([]);
  });

  it("returns [] when no rows found for sender", async () => {
    const supabase = buildMockSupabase([]);
    const hints = await loadMemoryHints(supabase, "tenant-1", "unknown@example.com");
    expect(hints).toEqual([]);
  });

  it("returns hints sorted by confidence desc (highest first)", async () => {
    const rows: MemoryRow[] = [
      {
        id: "m1",
        memory_type: "sender_profile",
        key: "sender@example.com",
        value: { full_name: "Juan Pérez" },
        confidence: 0.72,
        source: "auto_extracted",
        last_used_at: null,
      },
      {
        id: "m2",
        memory_type: "field_correction",
        key: "sender@example.com",
        value: { full_name: "Juan Carlos Pérez" },
        confidence: 0.90,
        source: "human_confirmation",
        last_used_at: "2024-01-15T10:00:00Z",
      },
    ];

    // The mock returns rows in the given order — the ordering is enforced by the DB.
    // We return them with high-confidence first to simulate the ORDER BY confidence DESC.
    const sortedRows = [rows[1], rows[0]]; // high confidence first
    const supabase = buildMockSupabase(sortedRows);

    const hints = await loadMemoryHints(supabase, "tenant-1", "sender@example.com");

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

    const supabase = buildMockSupabase(rows);
    const hints = await loadMemoryHints(supabase, "tenant-1", "claimant@example.com");

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

    const supabase = buildMockSupabase(rows);
    await loadMemoryHints(supabase, "tenant-1", "sender@example.com", undefined, "case-abc");

    // writeAuditLog is called fire-and-forget — it's a void promise so we check it was called
    // after a tick to let the fire-and-forget settle.
    await Promise.resolve();

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "memory.applied",
        target_id: "case-abc",
      })
    );
  });

  it("returns [] on DB error without throwing", async () => {
    const supabase = buildMockSupabase([], true);
    const hints = await loadMemoryHints(supabase, "tenant-1", "error@example.com");
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

    const supabase = buildMockSupabase(rows);
    const hints = await loadMemoryHints(
      supabase,
      "tenant-1",
      undefined,
      "+541112345678"
    );

    expect(hints).toHaveLength(1);
    expect(hints[0].key).toBe("+541112345678");
  });
});
