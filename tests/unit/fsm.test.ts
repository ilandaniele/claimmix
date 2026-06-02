/**
 * Unit tests for the case status FSM.
 *
 * Tests every valid transition and every invalid transition boundary.
 * The FSM is a pure function with no external dependencies.
 */

import { describe, it, expect } from "vitest";
import {
  FSM_TRANSITIONS,
  isValidTransition,
  getAllowedTransitions,
  validateTransition,
} from "@/server/cases/fsm";
import type { CaseStatus } from "@/lib/schemas/cases";

// ── FSM_TRANSITIONS shape ─────────────────────────────────────────────────────

describe("FSM_TRANSITIONS", () => {
  it("has entries for all five statuses", () => {
    const statuses: CaseStatus[] = [
      "procesando",
      "listo",
      "esperando",
      "escalado",
      "cerrado",
    ];
    for (const s of statuses) {
      expect(FSM_TRANSITIONS).toHaveProperty(s);
    }
  });

  it("cerrado is terminal — empty transitions array", () => {
    expect(FSM_TRANSITIONS.cerrado).toHaveLength(0);
  });
});

// ── isValidTransition — valid paths ──────────────────────────────────────────

describe("isValidTransition — valid transitions", () => {
  const validCases: [CaseStatus, CaseStatus][] = [
    ["procesando", "listo"],
    ["procesando", "esperando"],
    ["procesando", "escalado"],
    ["listo", "cerrado"],
    ["listo", "escalado"],
    ["esperando", "listo"],
    ["esperando", "escalado"],
    ["esperando", "cerrado"],
    ["escalado", "listo"],
    ["escalado", "cerrado"],
  ];

  for (const [from, to] of validCases) {
    it(`${from} → ${to} is valid`, () => {
      expect(isValidTransition(from, to)).toBe(true);
    });
  }
});

// ── isValidTransition — invalid paths ────────────────────────────────────────

describe("isValidTransition — invalid transitions", () => {
  const invalidCases: [CaseStatus, CaseStatus][] = [
    // Terminal state — no transitions allowed
    ["cerrado", "listo"],
    ["cerrado", "procesando"],
    ["cerrado", "esperando"],
    ["cerrado", "escalado"],
    ["cerrado", "cerrado"],
    // LLM08: AI must NEVER be able to directly set cerrado from procesando
    ["procesando", "cerrado"],
    // Skipping states
    ["procesando", "procesando"],
    ["listo", "procesando"],
    ["listo", "esperando"],
    ["escalado", "procesando"],
    ["escalado", "esperando"],
    ["esperando", "procesando"],
  ];

  for (const [from, to] of invalidCases) {
    it(`${from} → ${to} is invalid`, () => {
      expect(isValidTransition(from, to)).toBe(false);
    });
  }
});

// ── getAllowedTransitions ─────────────────────────────────────────────────────

describe("getAllowedTransitions", () => {
  it("procesando allows listo, esperando, escalado", () => {
    const allowed = getAllowedTransitions("procesando");
    expect(allowed).toContain("listo");
    expect(allowed).toContain("esperando");
    expect(allowed).toContain("escalado");
    expect(allowed).not.toContain("cerrado");
    expect(allowed).not.toContain("procesando");
  });

  it("cerrado returns empty array", () => {
    expect(getAllowedTransitions("cerrado")).toHaveLength(0);
  });

  it("listo allows cerrado and escalado", () => {
    const allowed = getAllowedTransitions("listo");
    expect(allowed).toContain("cerrado");
    expect(allowed).toContain("escalado");
    expect(allowed).not.toContain("procesando");
  });
});

// ── validateTransition ────────────────────────────────────────────────────────

describe("validateTransition", () => {
  it("returns null for valid transitions", () => {
    expect(validateTransition("procesando", "listo")).toBeNull();
    expect(validateTransition("listo", "cerrado")).toBeNull();
    expect(validateTransition("esperando", "escalado")).toBeNull();
    expect(validateTransition("escalado", "listo")).toBeNull();
  });

  it("returns a descriptive string for same-state transition", () => {
    const result = validateTransition("listo", "listo");
    expect(result).not.toBeNull();
    expect(result).toContain("listo");
  });

  it("returns a descriptive string for invalid transition", () => {
    const result = validateTransition("procesando", "cerrado");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
    expect(result!.length).toBeGreaterThan(0);
  });

  it("returns terminal message for cerrado → anything", () => {
    const result = validateTransition("cerrado", "listo");
    expect(result).not.toBeNull();
    expect(result).toContain("terminal");
  });

  it("returns allowed transitions in error message for invalid paths", () => {
    const result = validateTransition("procesando", "cerrado");
    // Should mention allowed next statuses
    expect(result).toMatch(/listo|esperando|escalado/);
  });
});

// ── LLM08 specific — AI cannot close a case ──────────────────────────────────

describe("LLM08: AI-reachable statuses from procesando", () => {
  const aiAllowedStatuses: CaseStatus[] = ["listo", "esperando", "escalado"];
  const aiProhibitedStatuses: CaseStatus[] = ["cerrado", "procesando"];

  for (const status of aiAllowedStatuses) {
    it(`procesando → ${status} is allowed (AI worker may use this)`, () => {
      expect(isValidTransition("procesando", status)).toBe(true);
    });
  }

  for (const status of aiProhibitedStatuses) {
    it(`procesando → ${status} is BLOCKED (AI cannot close a case)`, () => {
      expect(isValidTransition("procesando", status)).toBe(false);
    });
  }
});
