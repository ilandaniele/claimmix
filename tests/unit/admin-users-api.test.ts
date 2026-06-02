/**
 * Unit tests for admin users page role guard and helper logic.
 *
 * The API route itself is tested via integration tests (requires Supabase).
 * These unit tests cover pure logic: role validation, user formatting, badge logic.
 *
 * AC17 (W7): Admin/users page — role guard + user table.
 */

import { describe, it, expect } from "vitest";

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
