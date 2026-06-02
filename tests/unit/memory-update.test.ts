/**
 * Unit tests for updateMemoryFromConfirmation and seedMemoryFromExtraction.
 *
 * AC14: Memory only updated via confirm-field endpoint (updateMemoryFromConfirmation).
 * AC21: Audit log FIELD_CONFIRMED with redacted values.
 *
 * All DB calls are mocked — no real Supabase connection needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  updateMemoryFromConfirmation,
  seedMemoryFromExtraction,
} from "@/server/memory/update";
import type { ExtractedField } from "@/lib/schemas/extracted-claim";

// ── Mock audit/log ────────────────────────────────────────────────────────────
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    FIELD_CONFIRMED: "claim.field_confirmed",
  },
}));

// ── Mock Supabase builder ─────────────────────────────────────────────────────

function buildMockSupabase(
  existingRow: {
    id: string;
    value: Record<string, unknown>;
    use_count: number;
  } | null = null
) {
  const upsertMock = vi.fn().mockResolvedValue({ error: null });

  return {
    _upsertMock: upsertMock,
    from: (table: string) => {
      if (table === "claim_memory") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: existingRow, error: null }),
                }),
              }),
            }),
          }),
          upsert: upsertMock,
          update: () => ({
            in: vi.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      if (table === "missing_docs") {
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                is: () => Promise.resolve({ error: null }),
              }),
            }),
          }),
        };
      }
      return {};
    },
  } as any;
}

// ── Tests: updateMemoryFromConfirmation ──────────────────────────────────────

describe("updateMemoryFromConfirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts a new field_correction row when no existing row", async () => {
    const supabase = buildMockSupabase(null);

    await updateMemoryFromConfirmation(
      supabase,
      "tenant-1",
      "full_name",
      "Juan Pérez",
      "sender@example.com",
      "case-1",
      "user-1"
    );

    expect(supabase._upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "tenant-1",
        memory_type: "field_correction",
        key: "sender@example.com",
        value: expect.objectContaining({ full_name: "Juan Pérez" }),
        confidence: 0.90,
        source: "human_confirmation",
        use_count: 1,
      }),
      expect.objectContaining({ onConflict: "tenant_id,memory_type,key" })
    );
  });

  it("merges confirmed value into existing value JSON", async () => {
    const existing = {
      id: "m1",
      value: { dni: "35123456" },
      use_count: 2,
    };
    const supabase = buildMockSupabase(existing);

    await updateMemoryFromConfirmation(
      supabase,
      "tenant-1",
      "full_name",
      "Ana García",
      "sender@example.com",
      "case-1",
      "user-1"
    );

    expect(supabase._upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.objectContaining({
          dni: "35123456",    // preserved from existing
          full_name: "Ana García", // new value added
        }),
        use_count: 3, // incremented from 2
      }),
      expect.any(Object)
    );
  });

  it("AC21: calls writeAuditLog with FIELD_CONFIRMED event", async () => {
    const { writeAuditLog } = await import("@/lib/audit/log");
    const supabase = buildMockSupabase(null);

    await updateMemoryFromConfirmation(
      supabase,
      "tenant-1",
      "full_name",
      "Juan Pérez",
      "sender@example.com",
      "case-1",
      "user-1",
      "Pedro García" // old value
    );

    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "claim.field_confirmed",
        target_id: "case-1",
        actor_id: "user-1",
      })
    );
  });

  it("AC21: audit payload has redacted values (no raw PII in DNI/policy)", async () => {
    const { writeAuditLog } = await import("@/lib/audit/log");
    const supabase = buildMockSupabase(null);

    await updateMemoryFromConfirmation(
      supabase,
      "tenant-1",
      "dni",
      "35.123.456",     // DNI — should be redacted in audit payload
      "sender@example.com",
      "case-1",
      "user-1",
      "12.345.678"      // old DNI — should also be redacted
    );

    const callPayload = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
    // The redacted values should replace DNI patterns with [DNI]
    expect(callPayload.new_value).toBe("[DNI]");
    expect(callPayload.old_value).toBe("[DNI]");
  });

  it("does not throw on DB error (graceful degradation)", async () => {
    const upsertMock = vi.fn().mockResolvedValue({ error: { code: "DB_ERROR" } });
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          }),
        }),
        upsert: upsertMock,
      }),
    } as any;

    await expect(
      updateMemoryFromConfirmation(
        supabase,
        "tenant-1",
        "full_name",
        "Juan",
        "sender@example.com",
        "case-1"
      )
    ).resolves.toBeUndefined();
  });
});

// ── Tests: seedMemoryFromExtraction ──────────────────────────────────────────

describe("seedMemoryFromExtraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const highConfidenceFields: ExtractedField[] = [
    {
      field_key: "full_name",
      field_value: "Juan Pérez",
      confidence: 0.92,
      source: "ai",
    },
    {
      field_key: "dni",
      field_value: "35123456",
      confidence: 0.88,
      source: "ai",
    },
    {
      field_key: "policy_number",
      field_value: "POL-2024-001",
      confidence: 0.86,
      source: "ai",
    },
    // phone — should NOT be seeded (it's a lookup key)
    {
      field_key: "phone",
      field_value: "+541112345678",
      confidence: 0.95,
      source: "ai",
    },
    // email — should NOT be seeded
    {
      field_key: "email",
      field_value: "user@example.com",
      confidence: 0.99,
      source: "ai",
    },
  ];

  it("seeds only full_name, dni, policy_number — never phone or email", async () => {
    const supabase = buildMockSupabase(null);

    await seedMemoryFromExtraction(
      supabase,
      "tenant-1",
      "sender@example.com",
      highConfidenceFields,
      "case-1"
    );

    expect(supabase._upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.not.objectContaining({ phone: expect.anything() }),
      }),
      expect.any(Object)
    );
    expect(supabase._upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.not.objectContaining({ email: expect.anything() }),
      }),
      expect.any(Object)
    );
    // full_name, dni, policy_number should be seeded
    expect(supabase._upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.objectContaining({
          full_name: "Juan Pérez",
          dni: "35123456",
          policy_number: "POL-2024-001",
        }),
      }),
      expect.any(Object)
    );
  });

  it("discounts confidence by 0.8 factor for auto-seeded memory", async () => {
    const supabase = buildMockSupabase(null);

    const fields: ExtractedField[] = [
      { field_key: "full_name", field_value: "Ana García", confidence: 0.90, source: "ai" },
    ];

    await seedMemoryFromExtraction(supabase, "tenant-1", "s@example.com", fields, "c1");

    // min confidence is 0.90; discounted = 0.90 * 0.8 = 0.72
    expect(supabase._upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        confidence: 0.72,
        source: "auto_extracted",
      }),
      expect.any(Object)
    );
  });

  it("does NOT seed fields below 0.85 confidence threshold", async () => {
    const supabase = buildMockSupabase(null);

    const lowConfFields: ExtractedField[] = [
      { field_key: "full_name", field_value: "Juan", confidence: 0.75, source: "ai" },
      { field_key: "dni", field_value: "12345", confidence: 0.60, source: "ai" },
    ];

    await seedMemoryFromExtraction(supabase, "tenant-1", "s@example.com", lowConfFields, "c1");

    // No upsert should be called since no fields meet the threshold
    expect(supabase._upsertMock).not.toHaveBeenCalled();
  });

  it("uses ignoreDuplicates=true to not overwrite existing confirmed memory", async () => {
    const existing = { id: "m1", value: { full_name: "Existing" }, use_count: 5 };
    const supabase = buildMockSupabase(existing);

    const fields: ExtractedField[] = [
      { field_key: "full_name", field_value: "New Name", confidence: 0.95, source: "ai" },
    ];

    await seedMemoryFromExtraction(supabase, "tenant-1", "s@example.com", fields, "c1");

    // ignoreDuplicates=true ensures existing confirmed rows are not overwritten
    expect(supabase._upsertMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ ignoreDuplicates: true })
    );
  });

  it("returns early without calling DB when senderEmail is empty", async () => {
    const supabase = buildMockSupabase(null);

    const fields: ExtractedField[] = [
      { field_key: "full_name", field_value: "Juan", confidence: 0.92, source: "ai" },
    ];

    await seedMemoryFromExtraction(supabase, "tenant-1", "", fields, "c1");

    expect(supabase._upsertMock).not.toHaveBeenCalled();
  });
});
