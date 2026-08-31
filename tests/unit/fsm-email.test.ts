/**
 * Unit tests for the extended case status FSM — email-intake statuses.
 *
 * Tests every valid and invalid transition for the new email-intake statuses
 * (recibido, info_faltante, confirmacion_pendiente, requiere_especialista,
 * listo_para_core, enviado_a_core, error_core, no_relevante).
 *
 * AC16: FSM transitions enforced in code; invalid transitions return 400.
 * LLM08: AI worker cannot set terminal states (cerrado, enviado_a_core, no_relevante).
 */

import { describe, it, expect } from "vitest";
import {
  FSM_TRANSITIONS,
  isValidTransition,
  getAllowedTransitions,
  validateTransition,
  isTerminalStatus,
  isAiAllowedStatus,
  EMAIL_INITIAL_STATUS,
  AI_ALLOWED_STATUSES,
} from "@/core/case/fsm";
import type { CaseStatus } from "@/lib/schemas/cases";

// ── All statuses present in FSM map ──────────────────────────────────────────

describe("FSM_TRANSITIONS — completeness", () => {
  const allStatuses: CaseStatus[] = [
    // Legacy
    "procesando",
    "listo",
    "esperando",
    "escalado",
    "cerrado",
    // Email-intake
    "recibido",
    "info_faltante",
    "confirmacion_pendiente",
    "requiere_especialista",
    "listo_para_core",
    "enviado_a_core",
    "error_core",
    "no_relevante",
  ];

  it("has entries for all 13 statuses", () => {
    for (const s of allStatuses) {
      expect(FSM_TRANSITIONS).toHaveProperty(s);
    }
  });

  it("legacy statuses still have the same transitions as before", () => {
    expect(FSM_TRANSITIONS.procesando).toContain("listo");
    expect(FSM_TRANSITIONS.procesando).toContain("esperando");
    expect(FSM_TRANSITIONS.procesando).toContain("escalado");
    expect(FSM_TRANSITIONS.cerrado).toHaveLength(0);
    expect(FSM_TRANSITIONS.listo).toContain("cerrado");
    expect(FSM_TRANSITIONS.esperando).toContain("listo");
  });
});

// ── Terminal states ───────────────────────────────────────────────────────────

describe("isTerminalStatus", () => {
  it("cerrado is terminal", () => {
    expect(isTerminalStatus("cerrado")).toBe(true);
  });

  /*
   * `no_relevante` dejó de ser terminal del todo, y tiene UNA salida.
   *
   * Alguien escribía «hola», el clasificador lo daba por no-denuncia, y cuando
   * después mandaba la denuncia de verdad ese mensaje se guardaba y no lo leía
   * nadie: el worker no arranca desde un estado terminal. Es el balde más grande
   * de la base — 329 casos.
   *
   * La arista es `no_relevante → recibido` y NADA más, y la toma el camino de
   * ingreso cuando llega un mensaje. LLM08 sigue en pie: el modelo no puede
   * tomarla, igual que no puede ENTRAR a este estado por su cuenta.
   *
   * Ojo con lo que esto NO significa: «no terminal» no es «lo reabre cualquiera».
   * Para eso está `ESTADOS_QUE_NO_SE_REABREN_A_MANO`, que existe porque al abrir
   * la arista la guarda de permisos de `/re-analyze` —que preguntaba «¿es
   * terminal?»— se evaporó sola. Lo cazó un test que ya estaba.
   */
  it("no_relevante ya no es terminal: tiene una salida, y una sola", () => {
    expect(isTerminalStatus("no_relevante")).toBe(false);
    expect(getAllowedTransitions("no_relevante")).toEqual(["recibido"]);
  });

  it("non-terminal statuses return false", () => {
    const nonTerminal: CaseStatus[] = [
      "recibido",
      "info_faltante",
      "confirmacion_pendiente",
      "requiere_especialista",
      "listo_para_core",
      "enviado_a_core",
      "error_core",
      "procesando",
      "listo",
      "esperando",
      "escalado",
    ];
    for (const s of nonTerminal) {
      expect(isTerminalStatus(s), `${s} should not be terminal`).toBe(false);
    }
  });
});

// ── EMAIL_INITIAL_STATUS ──────────────────────────────────────────────────────

describe("EMAIL_INITIAL_STATUS", () => {
  it("is 'recibido'", () => {
    expect(EMAIL_INITIAL_STATUS).toBe("recibido");
  });
});

// ── Valid email-intake transitions ────────────────────────────────────────────

describe("isValidTransition — valid email-intake transitions", () => {
  const validCases: [CaseStatus, CaseStatus][] = [
    ["recibido", "info_faltante"],
    ["recibido", "confirmacion_pendiente"],
    ["recibido", "requiere_especialista"],
    ["recibido", "listo_para_core"],
    ["recibido", "no_relevante"],
    ["info_faltante", "recibido"],
    ["info_faltante", "confirmacion_pendiente"],
    ["confirmacion_pendiente", "recibido"],
    ["confirmacion_pendiente", "listo_para_core"],
    ["confirmacion_pendiente", "info_faltante"],
    ["requiere_especialista", "listo_para_core"],
    ["requiere_especialista", "cerrado"],
    ["listo_para_core", "enviado_a_core"],
    ["listo_para_core", "error_core"],
    ["enviado_a_core", "cerrado"],
    ["error_core", "listo_para_core"],
  ];

  for (const [from, to] of validCases) {
    it(`${from} → ${to} is valid`, () => {
      expect(isValidTransition(from, to)).toBe(true);
    });
  }
});

// ── Invalid email-intake transitions ─────────────────────────────────────────

describe("isValidTransition — invalid email-intake transitions", () => {
  const invalidCases: [CaseStatus, CaseStatus][] = [
    // Terminal states — no outgoing transitions
    ["no_relevante", "info_faltante"],
    ["no_relevante", "cerrado"],
    // Skip-state violations
    ["recibido", "enviado_a_core"],  // must go through listo_para_core
    ["recibido", "error_core"],      // must go through listo_para_core
    ["recibido", "cerrado"],         // must go through specialist/core
    ["info_faltante", "listo_para_core"], // must be confirmed first
    ["confirmacion_pendiente", "enviado_a_core"],
    ["listo_para_core", "cerrado"],  // must go through enviado_a_core
    ["listo_para_core", "recibido"], // cannot go back past listo
    ["enviado_a_core", "listo_para_core"], // cannot go backward
    ["enviado_a_core", "error_core"],
    ["error_core", "cerrado"],       // must retry first
    ["error_core", "enviado_a_core"],// must retry through listo_para_core
    // Same state
    ["recibido", "recibido"],
    ["listo_para_core", "listo_para_core"],
  ];

  for (const [from, to] of invalidCases) {
    it(`${from} → ${to} is invalid`, () => {
      expect(isValidTransition(from, to)).toBe(false);
    });
  }
});

// ── getAllowedTransitions — email statuses ────────────────────────────────────

describe("getAllowedTransitions — email-intake statuses", () => {
  it("recibido allows 5 transitions", () => {
    const allowed = getAllowedTransitions("recibido");
    expect(allowed).toHaveLength(5);
    expect(allowed).toContain("info_faltante");
    expect(allowed).toContain("confirmacion_pendiente");
    expect(allowed).toContain("requiere_especialista");
    expect(allowed).toContain("listo_para_core");
    expect(allowed).toContain("no_relevante");
  });

  it("info_faltante allows 4 transitions", () => {
    const allowed = getAllowedTransitions("info_faltante");
    expect(allowed).toHaveLength(4);
    expect(allowed).toContain("recibido");
    expect(allowed).toContain("confirmacion_pendiente");
    expect(allowed).toContain("requiere_especialista");
    expect(allowed).toContain("cerrado");
  });

  it("lets a waiting conversation be given up on", () => {
    // The abandonment exit. Without it a case where we asked and nobody ever
    // answered stays on the board forever — nineteen piled up in one day of
    // testing and had to be closed by hand.
    for (const from of ["info_faltante", "confirmacion_pendiente"] as const) {
      expect(isValidTransition(from, "cerrado"), from).toBe(true);
    }
  });

  it("lets a waiting case escalate when a reply reveals something serious", () => {
    // A first message can be vague and the follow-up mention an injury or a
    // fire. A claim that turns out to be serious must be able to escalate
    // rather than stay parked because of the status it happened to be in.
    for (const from of ["info_faltante", "confirmacion_pendiente"] as const) {
      expect(isValidTransition(from, "requiere_especialista"), from).toBe(true);
    }
  });

  it("listo_para_core allows enviado_a_core and error_core", () => {
    const allowed = getAllowedTransitions("listo_para_core");
    expect(allowed).toContain("enviado_a_core");
    expect(allowed).toContain("error_core");
    expect(allowed).not.toContain("cerrado");
    expect(allowed).not.toContain("recibido");
  });

  it("error_core allows only listo_para_core (retry)", () => {
    const allowed = getAllowedTransitions("error_core");
    expect(allowed).toHaveLength(1);
    expect(allowed).toContain("listo_para_core");
  });

  it("no_relevante sólo puede volver al principio del flujo", () => {
    expect(getAllowedTransitions("no_relevante")).toEqual(["recibido"]);
  });
});

// ── validateTransition — error messages ──────────────────────────────────────

describe("validateTransition — error messages for email statuses", () => {
  it("returns null for valid email-intake transitions", () => {
    expect(validateTransition("recibido", "info_faltante")).toBeNull();
    expect(validateTransition("listo_para_core", "enviado_a_core")).toBeNull();
    expect(validateTransition("error_core", "listo_para_core")).toBeNull();
  });

  it("desde no_relevante, el error nombra la única salida que hay", () => {
    /*
     * Antes decía «el estado es terminal» porque no había ninguna salida. Ahora
     * hay una —`recibido`, la que toma el camino de ingreso cuando llega un
     * mensaje— así que el mensaje útil es el que dice cuál es.
     *
     * Se comprueba contra `cerrado` y no contra `recibido`, que ahora es válida.
     */
    const result = validateTransition("no_relevante", "cerrado");
    expect(result).not.toBeNull();
    expect(result).toContain("recibido");
    expect(result).not.toContain("terminal");
  });

  it("y los que SÍ son terminales siguen diciendo «terminal»", () => {
    // El control: el mensaje de terminal no se perdió, cambió de dueño.
    const result = validateTransition("cerrado", "recibido");
    expect(result).toContain("terminal");
  });

  it("returns allowed list for invalid non-terminal transition", () => {
    const result = validateTransition("recibido", "enviado_a_core");
    expect(result).not.toBeNull();
    expect(result).toMatch(/info_faltante|confirmacion_pendiente|listo_para_core/);
  });

  it("returns same-state message", () => {
    const result = validateTransition("listo_para_core", "listo_para_core");
    expect(result).not.toBeNull();
    expect(result).toContain("listo_para_core");
  });
});

// ── LLM08: AI-reachable statuses ─────────────────────────────────────────────

describe("LLM08: AI worker allowed statuses", () => {
  const aiAllowedEmail: CaseStatus[] = [
    "recibido",
    "info_faltante",
    "confirmacion_pendiente",
    "requiere_especialista",
    "no_relevante",
  ];

  const aiProhibitedEmail: CaseStatus[] = [
    "listo_para_core",
    "enviado_a_core",
    "error_core",
    "cerrado",
  ];

  for (const status of aiAllowedEmail) {
    it(`AI may set status '${status}'`, () => {
      expect(isAiAllowedStatus(status)).toBe(true);
    });
  }

  for (const status of aiProhibitedEmail) {
    it(`AI may NOT set status '${status}' (LLM08)`, () => {
      expect(isAiAllowedStatus(status)).toBe(false);
    });
  }

  it("AI_ALLOWED_STATUSES is a Set", () => {
    expect(AI_ALLOWED_STATUSES).toBeInstanceOf(Set);
  });
});

// ── Retry loop: error_core → listo_para_core → enviado_a_core → cerrado ──────

describe("Retry loop path", () => {
  it("error_core can retry: error_core → listo_para_core → enviado_a_core → cerrado", () => {
    expect(isValidTransition("error_core", "listo_para_core")).toBe(true);
    expect(isValidTransition("listo_para_core", "enviado_a_core")).toBe(true);
    expect(isValidTransition("enviado_a_core", "cerrado")).toBe(true);
  });
});

// ── Full happy-path walk ──────────────────────────────────────────────────────

describe("Full happy-path: email claim walk", () => {
  it("recibido → confirmacion_pendiente → listo_para_core → enviado_a_core → cerrado", () => {
    const path: CaseStatus[] = [
      "recibido",
      "confirmacion_pendiente",
      "listo_para_core",
      "enviado_a_core",
      "cerrado",
    ];

    for (let i = 0; i < path.length - 1; i++) {
      expect(
        isValidTransition(path[i]!, path[i + 1]!),
        `${path[i]} → ${path[i + 1]}`
      ).toBe(true);
    }

    expect(isTerminalStatus("cerrado")).toBe(true);
  });

  it("not-relevant path: recibido → no_relevante, y la vuelta si escriben de nuevo", () => {
    expect(isValidTransition("recibido", "no_relevante")).toBe(true);
    // La vuelta existe y es la única: un mensaje nuevo devuelve el caso al flujo.
    expect(isValidTransition("no_relevante", "recibido")).toBe(true);
    expect(isValidTransition("no_relevante", "cerrado")).toBe(false);
  });
});
