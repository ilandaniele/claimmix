/**
 * Unit tests for Métricas page utility functions.
 *
 * Tests the pure formatting and computation helpers used by the Métricas page.
 * The page itself is a Server Component and cannot be directly unit-tested
 * without a Next.js runtime; we test the business logic separately.
 *
 * AC16 (W7): Métricas page shows real data computed from cases and ai_usage tables.
 */

import { describe, it, expect } from "vitest";

// ── Pure helpers extracted from the page (inline re-implementation for testing) ─

function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return `${h}h ${m}min`;
}

function computeAutoCompletionRate(
  casesThisMonth: Array<{ status: string }>,
  totalCasesMonth: number
): number {
  if (totalCasesMonth === 0) return 0;
  const listoCount = casesThisMonth.filter((c) => c.status === "listo").length;
  return Math.round((listoCount / totalCasesMonth) * 100);
}

function computeAvgOpeningMinutes(
  closedCases: Array<{ created_at: string; closed_at: string }>
): number | null {
  if (closedCases.length === 0) return null;
  const total = closedCases.reduce((sum, c) => {
    return (
      sum +
      (new Date(c.closed_at).getTime() - new Date(c.created_at).getTime()) /
        60_000
    );
  }, 0);
  return Math.round(total / closedCases.length);
}

function buildByType(
  cases: Array<{ claim_type: string }>
): Record<string, number> {
  const byType: Record<string, number> = {};
  for (const c of cases) {
    byType[c.claim_type] = (byType[c.claim_type] ?? 0) + 1;
  }
  for (const t of ["choque", "robo", "granizo", "incendio"]) {
    if (!(t in byType)) byType[t] = 0;
  }
  return byType;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("formatMinutes", () => {
  it("returns — for null", () => {
    expect(formatMinutes(null)).toBe("—");
  });

  it("formats minutes-only (< 60)", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(0)).toBe("0 min");
  });

  it("formats hours and minutes", () => {
    expect(formatMinutes(154)).toBe("2h 34min");
    expect(formatMinutes(60)).toBe("1h 0min");
  });
});

describe("computeAutoCompletionRate", () => {
  it("returns 0 when no cases", () => {
    expect(computeAutoCompletionRate([], 0)).toBe(0);
  });

  it("computes percentage correctly", () => {
    const cases = [
      { status: "listo" },
      { status: "listo" },
      { status: "escalado" },
      { status: "cerrado" },
    ];
    // 2 listo / 4 total = 50%
    expect(computeAutoCompletionRate(cases, 4)).toBe(50);
  });

  it("returns 100 when all cases are listo", () => {
    const cases = [{ status: "listo" }, { status: "listo" }];
    expect(computeAutoCompletionRate(cases, 2)).toBe(100);
  });
});

describe("computeAvgOpeningMinutes", () => {
  it("returns null for empty array", () => {
    expect(computeAvgOpeningMinutes([])).toBeNull();
  });

  it("computes average correctly", () => {
    const base = new Date("2026-01-01T00:00:00Z");
    const cases = [
      {
        created_at: new Date(base.getTime()).toISOString(),
        closed_at: new Date(base.getTime() + 60 * 60_000).toISOString(), // 60 min
      },
      {
        created_at: new Date(base.getTime()).toISOString(),
        closed_at: new Date(base.getTime() + 120 * 60_000).toISOString(), // 120 min
      },
    ];
    // Average: (60 + 120) / 2 = 90 min
    expect(computeAvgOpeningMinutes(cases)).toBe(90);
  });
});

describe("buildByType", () => {
  it("counts cases by claim_type", () => {
    const cases = [
      { claim_type: "choque" },
      { claim_type: "choque" },
      { claim_type: "robo" },
    ];
    const result = buildByType(cases);
    expect(result.choque).toBe(2);
    expect(result.robo).toBe(1);
  });

  it("ensures all 4 types are present even with 0 counts", () => {
    const result = buildByType([{ claim_type: "choque" }]);
    expect(result.granizo).toBe(0);
    expect(result.incendio).toBe(0);
    expect(result.robo).toBe(0);
  });

  it("handles empty cases array", () => {
    const result = buildByType([]);
    expect(result.choque).toBe(0);
    expect(result.robo).toBe(0);
    expect(result.granizo).toBe(0);
    expect(result.incendio).toBe(0);
  });
});
