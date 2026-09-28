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
  ESTADOS_QUE_NO_SE_REABREN_A_MANO,
  REAPERTURA_POR_ABANDONO,
  SALIDAS_A_MANO,
  esSalidaAMano,
  isTerminalStatus,
  isAiAllowedStatus,
  ESTADOS_RESUELTOS,
  ESTADOS_COMPLETADO_SIN_PERSONA,
  ESTADOS_CERRADOS,
} from "@/core/case/fsm";
import { puedeArrancar } from "@/core/case/estados-de-arranque";
import { CaseStatusSchema, type CaseStatus } from "@/lib/schemas/cases";

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

// ── P8: cerrado sigue sin arista de vuelta ────────────────────────────────────

describe("P8: REAPERTURA_POR_ABANDONO no es una transición nueva", () => {
  it("cerrado sigue terminal, sin arista hacia info_faltante", () => {
    expect(FSM_TRANSITIONS.cerrado).toHaveLength(0);
    expect(isValidTransition("cerrado", "info_faltante")).toBe(false);
  });

  it("cerrado sigue en ESTADOS_QUE_NO_SE_REABREN_A_MANO", () => {
    expect(ESTADOS_QUE_NO_SE_REABREN_A_MANO.has("cerrado")).toBe(true);
  });

  it("REAPERTURA_POR_ABANDONO sólo documenta la excepción, no la habilita acá", () => {
    expect(REAPERTURA_POR_ABANDONO).toEqual({ desde: "cerrado", hacia: "info_faltante" });
  });
});

// ── B25: salidas a mano y estados de liquidación ─────────────────────────────

describe("B25: SALIDAS_A_MANO vive fuera del grafo", () => {
  const NUEVOS: CaseStatus[] = ["en_liquidacion", "pagado", "rechazado"];
  const TODOS = CaseStatusSchema.options;

  it("los tres estados nuevos son terminales en el grafo", () => {
    for (const s of NUEVOS) {
      expect(FSM_TRANSITIONS[s]).toHaveLength(0);
      expect(isTerminalStatus(s)).toBe(true);
    }
  });

  it("LLM08: ninguna arista del grafo llega a un estado nuevo", () => {
    // El worker, confirm-field y la reapertura de no_relevante caminan el
    // grafo: si una arista llegara a en_liquidacion, podrían tomarla.
    for (const desde of TODOS) {
      for (const hacia of NUEVOS) {
        expect(isValidTransition(desde, hacia), `${desde} → ${hacia}`).toBe(false);
      }
    }
  });

  it("ni la IA ni el worker arrancan en un estado nuevo", () => {
    for (const s of NUEVOS) {
      expect(isAiAllowedStatus(s)).toBe(false);
      expect(puedeArrancar(s)).toBe(false);
    }
  });

  it("los estados nuevos no se re-analizan", () => {
    for (const s of NUEVOS) expect(ESTADOS_QUE_NO_SE_REABREN_A_MANO.has(s)).toBe(true);
  });

  it.each([
    ["listo_para_core", "en_liquidacion"],
    ["listo_para_core", "cerrado"],
    ["error_core", "en_liquidacion"],
    ["error_core", "cerrado"],
    ["enviado_a_core", "en_liquidacion"],
    ["en_liquidacion", "pagado"],
    ["en_liquidacion", "rechazado"],
    ["en_liquidacion", "cerrado"],
  ] as [CaseStatus, CaseStatus][])("%s → %s es salida a mano", (desde, hacia) => {
    expect(esSalidaAMano(desde, hacia)).toBe(true);
  });

  it("son ocho aristas, ni una más", () => {
    const aristas = Object.values(SALIDAS_A_MANO).reduce((n, h) => n + (h?.length ?? 0), 0);
    expect(aristas).toBe(8);
  });

  it.each([
    ["listo_para_core", "enviado_a_core"],
    ["listo_para_core", "error_core"],
    ["error_core", "enviado_a_core"],
    ["en_liquidacion", "enviado_a_core"],
    ["en_liquidacion", "listo_para_core"],
    ["enviado_a_core", "pagado"],
    ["enviado_a_core", "cerrado"],
    ["pagado", "en_liquidacion"],
    ["pagado", "cerrado"],
    ["rechazado", "cerrado"],
    ["cerrado", "en_liquidacion"],
    ["listo", "en_liquidacion"],
    ["recibido", "pagado"],
  ] as [CaseStatus, CaseStatus][])("%s → %s no es salida a mano", (desde, hacia) => {
    expect(esSalidaAMano(desde, hacia)).toBe(false);
  });

  it("ninguna salida a mano es también arista del grafo", () => {
    for (const [desde, hacias] of Object.entries(SALIDAS_A_MANO) as [CaseStatus, CaseStatus[]][]) {
      for (const hacia of hacias) expect(isValidTransition(desde, hacia), `${desde} → ${hacia}`).toBe(false);
    }
  });

  it("ninguna salida a mano pone enviado_a_core ni error_core", () => {
    for (const hacias of Object.values(SALIDAS_A_MANO)) {
      expect(hacias).not.toContain("enviado_a_core");
      expect(hacias).not.toContain("error_core");
    }
  });

  it("RESUELTOS = COMPLETADO_SIN_PERSONA ∪ CERRADOS, sin pisarse", () => {
    expect([...ESTADOS_RESUELTOS].sort()).toEqual(
      [...ESTADOS_COMPLETADO_SIN_PERSONA, ...ESTADOS_CERRADOS].sort()
    );
    for (const s of ESTADOS_CERRADOS) expect(ESTADOS_COMPLETADO_SIN_PERSONA.has(s)).toBe(false);
    expect(ESTADOS_COMPLETADO_SIN_PERSONA.has("en_liquidacion")).toBe(true);
    expect([...ESTADOS_CERRADOS].sort()).toEqual(["cerrado", "pagado", "rechazado"]);
  });
});
