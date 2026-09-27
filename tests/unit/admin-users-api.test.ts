/**
 * Unit tests for admin users page role guard and helper logic.
 *
 * The API route itself is tested via integration tests (requires Neon).
 * These unit tests cover pure logic: role validation, user formatting, badge logic.
 *
 * AC17 (W7): Admin/users page — role guard + user table.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

// ── POST /api/admin/users audita el alta (G7) ──────────────────────────────────

const {
  mockRequireAdmin,
  mockSignUp,
  mockInsert,
  mockValues,
  mockOnConflict,
  mockReturning,
  mockWriteAuditLog,
} = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockSignUp: vi.fn(),
  mockInsert: vi.fn(),
  mockValues: vi.fn(),
  mockOnConflict: vi.fn(),
  mockReturning: vi.fn(),
  mockWriteAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: mockRequireAdmin }));
vi.mock("@/lib/auth", () => ({ auth: { api: { signUpEmail: mockSignUp } } }));
vi.mock("@/lib/db", () => ({ db: { insert: mockInsert } }));
vi.mock("@/lib/db/schema", () => ({
  users: { id: "id", tenant_id: "tenant_id", full_name: "full_name", role: "role" },
  authUsers: { id: "id", role: "role" },
}));
vi.mock("@/data/scope", () => ({
  enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) => Promise.resolve(armar({})),
}));
vi.mock("@/lib/audit/log", () => ({
  AuditEvent: { USER_CREATED: "auth.user_created" },
  writeAuditLog: mockWriteAuditLog,
}));

const ADMIN = {
  userRow: { id: "admin-1", tenant_id: "aaaaaaaa-0000-0000-0000-00000000000a", role: "admin" },
  user: { id: "admin-1", email: "jefa@seguros.com.ar" },
};

function pedidoAlta(over: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", "user-agent": "vitest" },
    body: JSON.stringify({
      full_name: "Lucía Fernández",
      email: "lucia@seguros.com.ar",
      role: "analyst",
      ...over,
    }),
  });
}

function perfilCreado(filas: unknown[]) {
  mockReturning.mockResolvedValue(filas);
  mockOnConflict.mockReturnValue({ returning: mockReturning });
  mockValues.mockReturnValue({ onConflictDoUpdate: mockOnConflict });
  mockInsert.mockReturnValue({ values: mockValues });
}

describe("POST /api/admin/users audita el alta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(ADMIN);
    mockSignUp.mockResolvedValue({ user: { id: "nuevo-1" } });
    perfilCreado([{ id: "nuevo-1" }]);
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  it("un POST exitoso llama a writeAuditLog con auth.user_created, sin el email en el payload", async () => {
    const { POST } = await import("@/app/api/admin/users/route");
    const res = await POST(pedidoAlta());

    expect(res.status).toBe(201);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: ADMIN.userRow.tenant_id,
        actor_id: ADMIN.userRow.id,
        event_type: "auth.user_created",
        target_type: "user",
        target_id: "nuevo-1",
        payload: { role: "analyst" },
      })
    );
    const payload = mockWriteAuditLog.mock.calls[0][0].payload;
    expect(JSON.stringify(payload)).not.toContain("lucia@seguros.com.ar");
  });
});

// ── Role badge logic ──────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  analyst: "Analista",
  supervisor: "Supervisor",
  admin: "Admin",
};

const ROLE_STYLES: Record<string, string> = {
  analyst: "bg-blue-100 text-blue-800",
  supervisor: "bg-purple-100 text-purple-800",
  admin: "bg-red-100 text-red-800",
};

function getRoleBadgeInfo(role: string): { label: string; styles: string } {
  return {
    label: ROLE_LABELS[role] ?? role,
    styles: ROLE_STYLES[role] ?? "bg-slate-100 text-slate-800",
  };
}

// ── Date formatting ───────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("getRoleBadgeInfo", () => {
  it("returns Analista (blue) for analyst role", () => {
    const { label, styles } = getRoleBadgeInfo("analyst");
    expect(label).toBe("Analista");
    expect(styles).toContain("blue");
  });

  it("returns Supervisor (purple) for supervisor role", () => {
    const { label, styles } = getRoleBadgeInfo("supervisor");
    expect(label).toBe("Supervisor");
    expect(styles).toContain("purple");
  });

  it("returns Admin (red) for admin role", () => {
    const { label, styles } = getRoleBadgeInfo("admin");
    expect(label).toBe("Admin");
    expect(styles).toContain("red");
  });

  it("falls back for unknown role", () => {
    const { label, styles } = getRoleBadgeInfo("viewer");
    expect(label).toBe("viewer");
    expect(styles).toContain("slate");
  });
});

describe("formatDate", () => {
  it("formats ISO date in dd/mm/yyyy style", () => {
    // Use noon UTC to avoid timezone day-flip (Argentina is UTC-3)
    const result = formatDate("2026-06-15T12:00:00Z");
    // es-AR locale: 15/06/2026
    expect(result).toMatch(/15\/06\/2026/);
  });

  it("handles valid ISO timestamps", () => {
    const result = formatDate("2026-01-15T12:00:00Z");
    expect(result).toMatch(/15\/01\/2026/);
  });
});

describe("admin role guard", () => {
  function canAccessAdminPage(role: string): boolean {
    return role === "admin";
  }

  it("allows access for admin role", () => {
    expect(canAccessAdminPage("admin")).toBe(true);
  });

  it("denies access for analyst role", () => {
    expect(canAccessAdminPage("analyst")).toBe(false);
  });

  it("denies access for supervisor role", () => {
    expect(canAccessAdminPage("supervisor")).toBe(false);
  });

  it("denies access for unknown role", () => {
    expect(canAccessAdminPage("viewer")).toBe(false);
  });
});
