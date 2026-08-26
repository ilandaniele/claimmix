/**
 * Unit tests for updateMemoryFromConfirmation and seedMemoryFromExtraction.
 *
 * AC14: Memory only updated via confirm-field endpoint (updateMemoryFromConfirmation).
 * AC21: Audit log FIELD_CONFIRMED with redacted values.
 *
 * All DB calls are mocked — no real DB connection needed.
 */

// ── Mock @/lib/db BEFORE any imports ─────────────────────────────────────────
// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: el mock de @/lib/db
// suele exponer `db` con un getter para que los tests puedan intercambiar la
// base simulada entre corridas, y un `const { db } = ...` congelaría el valor
// de la primera llamada.
//
// Lo que NO se prueba acá es que el contexto de inquilino llegue a la base:
// eso se verifica en tests/unit/data-scope-sin-rol.test.ts y, contra bases de
// verdad, en `pnpm capa-datos` y `pnpm tenancy`.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => {
  const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
  const onConflictDoNothing = vi.fn().mockResolvedValue([]);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate, onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });

  const limit = vi.fn().mockResolvedValue([]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  return {
    db: { select, insert },
    tables: {
      claimMemory: {
        id: "id",
        tenant_id: "tenant_id",
        memory_type: "memory_type",
        key: "key",
        value: "value",
        use_count: "use_count",
        confidence: "confidence",
        source: "source",
        last_used_at: "last_used_at",
      },
    },
  };
});

// ── Mock drizzle-orm operators ────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

// ── Mock @/lib/db/helpers ─────────────────────────────────────────────────────
vi.mock("@/lib/db/helpers", () => ({
  firstRow: vi.fn((rows: unknown[]) => rows[0] ?? null),
}));

// ── Mock audit/log ────────────────────────────────────────────────────────────
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    FIELD_CONFIRMED: "claim.field_confirmed",
  },
}));

// ── Mock audit/redact ─────────────────────────────────────────────────────────
vi.mock("@/lib/audit/redact", () => ({
  redactObject: vi.fn((obj: Record<string, unknown>) => {
    // Default pass-through; individual tests can override for PII checks.
    return { ...obj };
  }),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  updateMemoryFromConfirmation,
  seedMemoryFromExtraction,
} from "@/server/memory/update";
import type { ExtractedField } from "@/lib/schemas/extracted-claim";
import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";

// Helper: rebuild the insert chain mocks and wire them into db.insert
function makeInsertChain() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
  const onConflictDoNothing = vi.fn().mockResolvedValue([]);
  const valuesMock = vi.fn().mockReturnValue({ onConflictDoUpdate, onConflictDoNothing });
  vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as ReturnType<typeof db.insert>);
  return { valuesMock, onConflictDoUpdate, onConflictDoNothing };
}

// Helper: rebuild the select chain mocks returning the given rows
function makeSelectChain(rows: unknown[] = []) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as ReturnType<typeof db.select>);
  vi.mocked(firstRow).mockReturnValue(rows[0] ?? null);
}

// ── Tests: updateMemoryFromConfirmation ──────────────────────────────────────

describe("updateMemoryFromConfirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    makeSelectChain([]);
    makeInsertChain();
  });

  it("upserts a new field_correction row when no existing row", async () => {
    const { valuesMock } = makeInsertChain();

    await updateMemoryFromConfirmation(
      "tenant-1",
      "full_name",
      "Juan Pérez",
      "sender@example.com",
      "case-1",
      "user-1"
    );

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "tenant-1",
        memory_type: "field_correction",
        key: "sender@example.com",
        value: expect.objectContaining({ full_name: "Juan Pérez" }),
        confidence: 0.90,
        source: "human_confirmation",
        use_count: 1,
      })
    );
  });

  it("merges confirmed value into existing value JSON", async () => {
    const existingRow = {
      id: "m1",
      value: { dni: "35123456" },
      use_count: 2,
    };

    makeSelectChain([existingRow]);

    const { valuesMock } = makeInsertChain();

    await updateMemoryFromConfirmation(
      "tenant-1",
      "full_name",
      "Ana García",
      "sender@example.com",
      "case-1",
      "user-1"
    );

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.objectContaining({
          dni: "35123456",        // preserved from existing
          full_name: "Ana García", // new value added
        }),
        use_count: 3, // incremented from 2
      })
    );
  });

  it("AC21: calls writeAuditLog with FIELD_CONFIRMED event", async () => {
    const { writeAuditLog } = await import("@/lib/audit/log");

    await updateMemoryFromConfirmation(
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
    const { redactObject } = await import("@/lib/audit/redact");

    // Override redactObject to redact DNI patterns
    vi.mocked(redactObject).mockImplementation((obj: Record<string, unknown>) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") {
          // Redact DNI pattern: 8 digits optionally separated by dots
          if (/^\d{2}\.?\d{3}\.?\d{3}$/.test(v.replace(/\./g, ""))) {
            result[k] = "[DNI]";
          } else {
            result[k] = v;
          }
        } else {
          result[k] = v;
        }
      }
      return result;
    });

    await updateMemoryFromConfirmation(
      "tenant-1",
      "dni",
      "35.123.456",      // DNI — should be redacted in audit payload
      "sender@example.com",
      "case-1",
      "user-1",
      "12.345.678"       // old DNI — should also be redacted
    );

    const callPayload = (writeAuditLog as ReturnType<typeof vi.fn>).mock.calls[0][0].payload;
    // The redacted values should replace DNI patterns with [DNI]
    expect(callPayload.new_value).toBe("[DNI]");
    expect(callPayload.old_value).toBe("[DNI]");
  });

  it("does not throw on DB error (graceful degradation)", async () => {
    // Make insert throw to simulate DB error
    vi.mocked(db.insert).mockImplementation(() => {
      throw new Error("DB_ERROR");
    });

    await expect(
      updateMemoryFromConfirmation(
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
    makeSelectChain([]);
    makeInsertChain();
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
    const { valuesMock } = makeInsertChain();

    await seedMemoryFromExtraction(
      "tenant-1",
      "sender@example.com",
      highConfidenceFields,
      "case-1"
    );

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.not.objectContaining({ phone: expect.anything() }),
      })
    );
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.not.objectContaining({ email: expect.anything() }),
      })
    );
    // full_name, dni, policy_number should be seeded
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.objectContaining({
          full_name: "Juan Pérez",
          dni: "35123456",
          policy_number: "POL-2024-001",
        }),
      })
    );
  });

  it("discounts confidence by 0.8 factor for auto-seeded memory", async () => {
    const { valuesMock } = makeInsertChain();

    const fields: ExtractedField[] = [
      { field_key: "full_name", field_value: "Ana García", confidence: 0.90, source: "ai" },
    ];

    await seedMemoryFromExtraction("tenant-1", "s@example.com", fields, "c1");

    // min confidence is 0.90; discounted = 0.90 * 0.8 = 0.72
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        confidence: 0.72,
        source: "auto_extracted",
      })
    );
  });

  it("does NOT seed fields below 0.85 confidence threshold", async () => {
    const { valuesMock } = makeInsertChain();

    const lowConfFields: ExtractedField[] = [
      { field_key: "full_name", field_value: "Juan", confidence: 0.75, source: "ai" },
      { field_key: "dni", field_value: "12345", confidence: 0.60, source: "ai" },
    ];

    await seedMemoryFromExtraction("tenant-1", "s@example.com", lowConfFields, "c1");

    // No insert should be called since no fields meet the threshold
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("uses onConflictDoNothing to not overwrite existing confirmed memory", async () => {
    const { onConflictDoNothing } = makeInsertChain();

    const fields: ExtractedField[] = [
      { field_key: "full_name", field_value: "New Name", confidence: 0.95, source: "ai" },
    ];

    await seedMemoryFromExtraction("tenant-1", "s@example.com", fields, "c1");

    // onConflictDoNothing ensures existing confirmed rows are not overwritten
    expect(onConflictDoNothing).toHaveBeenCalled();
  });

  it("returns early without calling DB when senderEmail is empty", async () => {
    const { valuesMock } = makeInsertChain();

    const fields: ExtractedField[] = [
      { field_key: "full_name", field_value: "Juan", confidence: 0.92, source: "ai" },
    ];

    await seedMemoryFromExtraction("tenant-1", "", fields, "c1");

    expect(db.insert).not.toHaveBeenCalled();
  });
});
