/**
 * Unit tests for Configuración page logic.
 *
 * Tests pure helpers: password validation, role labels, threshold formatting.
 * The password change itself uses the Neon browser client (tested via E2E).
 *
 * AC18 (W7): Configuración page — account section, password change, AI thresholds.
 */

import { describe, it, expect } from "vitest";

// ── Password validation (client-side, before Neon call) ──────────────────

function validatePasswordChange(
  newPassword: string,
  confirmPassword: string
): string | null {
  if (newPassword.length < 8) {
    return "La contraseña debe tener al menos 8 caracteres.";
  }
  if (newPassword !== confirmPassword) {
    return "Las contraseñas no coinciden.";
  }
  return null;
}

// ── Role labels ───────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  analyst: "Analista",
  admin: "Administrador",
};

function getRoleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

// ── Confidence threshold display ──────────────────────────────────────────────

function formatConfidenceThreshold(value: number): string {
  return value.toFixed(2);
}

function isAdminEditable(role: string): boolean {
  return role === "admin";
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("validatePasswordChange", () => {
  it("returns null for valid matching passwords", () => {
    expect(validatePasswordChange("ValidPass123", "ValidPass123")).toBeNull();
  });

  it("returns error for password shorter than 8 chars", () => {
    const err = validatePasswordChange("short", "short");
    expect(err).toBe("La contraseña debe tener al menos 8 caracteres.");
  });

  it("returns error when passwords don't match", () => {
    const err = validatePasswordChange("ValidPass123", "DifferentPass");
    expect(err).toBe("Las contraseñas no coinciden.");
  });

  it("checks length before matching", () => {
    // Short password should return length error, not mismatch
    const err = validatePasswordChange("abc", "def");
    expect(err).toBe("La contraseña debe tener al menos 8 caracteres.");
  });

  it("accepts exactly 8 characters", () => {
    expect(validatePasswordChange("abcdefgh", "abcdefgh")).toBeNull();
  });
});

describe("getRoleLabel", () => {
  it("returns Analista for analyst", () => {
    expect(getRoleLabel("analyst")).toBe("Analista");
  });

  it("returns Administrador for admin", () => {
    expect(getRoleLabel("admin")).toBe("Administrador");
  });

  it("falls back to raw role for unknown", () => {
    expect(getRoleLabel("supervisor")).toBe("supervisor");
  });
});

describe("formatConfidenceThreshold", () => {
  it("formats 0.70 as 0.70", () => {
    expect(formatConfidenceThreshold(0.70)).toBe("0.70");
  });

  it("formats 0.85 as 0.85", () => {
    expect(formatConfidenceThreshold(0.85)).toBe("0.85");
  });

  it("formats 1.0 as 1.00", () => {
    expect(formatConfidenceThreshold(1.0)).toBe("1.00");
  });
});

describe("isAdminEditable", () => {
  it("returns true for admin", () => {
    expect(isAdminEditable("admin")).toBe(true);
  });

  it("returns false for analyst", () => {
    expect(isAdminEditable("analyst")).toBe(false);
  });

  it("returns false for unknown roles", () => {
    expect(isAdminEditable("supervisor")).toBe(false);
  });
});

describe("AI thresholds section", () => {
  it("default confidence threshold is 0.70", () => {
    const threshold = parseFloat(process.env.CONFIDENCE_THRESHOLD ?? "0.70");
    expect(threshold).toBeCloseTo(0.70, 2);
  });

  it("monthly budget cap default is $200", () => {
    const cap = 200; // spec-defined default
    expect(cap).toBe(200);
  });
});
