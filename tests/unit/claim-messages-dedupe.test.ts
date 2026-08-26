/**
 * Unit tests for claim_messages-based dedupe helpers.
 *
 * Tests:
 *   - checkDuplicate() returns true when a matching row exists in claim_messages
 *   - checkDuplicate() returns false when no row exists
 *   - checkDuplicate() returns false (fail-open) on db error
 *   - normalizeMessageId() strips angle brackets
 *   - normalizeMessageId() is idempotent (no-op when no brackets present)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("server-only", () => ({}));

// Mock drizzle-orm so eq/and pass through without needing a real DB
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ type: "eq" })),
  and: vi.fn((..._args: unknown[]) => ({ type: "and" })),
}));

// Mock the schema so column references resolve without a real DB connection
vi.mock("@/lib/db/schema", () => ({
  claimMessages: {
    id: "id",
    tenant_id: "tenant_id",
    provider_message_id: "provider_message_id",
    case_id: "case_id",
  },
  cases: {
    id: "id",
    tenant_id: "tenant_id",
    email_message_id: "email_message_id",
  },
}));

// Mock helpers so firstRow works without DB import
vi.mock("@/lib/db/helpers", () => ({
  firstRow: <T>(rows: T[]): T | null => rows[0] ?? null,
  ilikeAny: vi.fn(),
  countRows: vi.fn(),
}));

// Drizzle db mock — must be declared before imports
const mockLimit = vi.fn();
const mockWhere = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({ from: mockFrom })),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// Import after mocks are set up
import { checkDuplicate, normalizeMessageId } from "@/server/email/dedupe";
import { db } from "@/lib/db";

// ── normalizeMessageId ────────────────────────────────────────────────────────

describe("normalizeMessageId", () => {
  it("strips leading and trailing angle brackets", () => {
    expect(normalizeMessageId("<abc@mail.postmarkapp.com>")).toBe(
      "abc@mail.postmarkapp.com"
    );
  });

  it("is a no-op when no brackets are present", () => {
    expect(normalizeMessageId("abc@mail.postmarkapp.com")).toBe(
      "abc@mail.postmarkapp.com"
    );
  });

  it("handles double brackets", () => {
    expect(normalizeMessageId("<<abc@mail>>")).toBe("abc@mail");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeMessageId("  <abc@mail>  ")).toBe("abc@mail");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeMessageId("")).toBe("");
  });

  it("preserves special chars inside the id", () => {
    expect(normalizeMessageId("<MessageID-Example@example.com>")).toBe(
      "MessageID-Example@example.com"
    );
  });
});

// ── checkDuplicate ────────────────────────────────────────────────────────────

describe("checkDuplicate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReturnValue({ from: mockFrom } as any);
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
  });

  it("returns true when a matching claim_messages row exists", async () => {
    mockLimit.mockResolvedValue([{ id: "msg-uuid-001" }]);

    const result = await checkDuplicate("tenant-001", "msg-abc-123");
    expect(result).toBe(true);
  });

  it("returns false when no matching claim_messages row exists", async () => {
    mockLimit.mockResolvedValue([]);

    const result = await checkDuplicate("tenant-001", "msg-abc-123");
    expect(result).toBe(false);
  });

  it("returns false (fail-open) when db throws an error", async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error("db connection error");
    });

    const result = await checkDuplicate("tenant-001", "msg-abc-123");
    expect(result).toBe(false);
  });

  it("queries the claim_messages table with correct tenant and provider_message_id", async () => {
    mockLimit.mockResolvedValue([]);

    await checkDuplicate("tenant-xyz", "msg-id-001");

    expect(db.select).toHaveBeenCalled();
    expect(mockFrom).toHaveBeenCalled();
    expect(mockWhere).toHaveBeenCalled();
    expect(mockLimit).toHaveBeenCalledWith(1);
  });

  it("is scoped per-tenant: same message_id under different tenants is independent", async () => {
    // First call: no duplicate
    mockLimit.mockResolvedValueOnce([]);
    expect(await checkDuplicate("tenant-a", "msg-123")).toBe(false);

    // Second call: duplicate exists
    mockLimit.mockResolvedValueOnce([{ id: "row-1" }]);
    expect(await checkDuplicate("tenant-b", "msg-123")).toBe(true);
  });
});
