/**
 * Case status FSM — finite-state machine for ClaimMix case statuses.
 *
 * Valid transitions (from spec + LLM08 containment requirement):
 *   procesando → listo | esperando | escalado
 *   listo      → cerrado | escalado
 *   esperando  → listo | escalado | cerrado
 *   escalado   → listo | cerrado
 *   cerrado    → (terminal — no transitions allowed)
 *
 * AC15: FSM enforced in code; invalid transitions return 409.
 * LLM08: The AI worker can NEVER write 'cerrado' — it is a terminal state
 *         reserved for human PATCH actions. The FSM map enforces this.
 *
 * OWASP API5: status updates go through this FSM — no arbitrary status writes.
 */

import type { CaseStatus } from "@/lib/schemas/cases";

/**
 * Allowed next statuses for each current status.
 * An empty array means terminal — no further transitions.
 */
export const FSM_TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  procesando: ["listo", "esperando", "escalado"],
  listo: ["cerrado", "escalado"],
  esperando: ["listo", "escalado", "cerrado"],
  escalado: ["listo", "cerrado"],
  cerrado: [], // terminal
} as const;

/**
 * Check whether a status transition is valid.
 *
 * @param from - Current status of the case.
 * @param to   - Requested next status.
 * @returns true if the transition is permitted by the FSM.
 */
export function isValidTransition(from: CaseStatus, to: CaseStatus): boolean {
  return (FSM_TRANSITIONS[from] as readonly CaseStatus[]).includes(to);
}

/**
 * Get the allowed next statuses from a given current status.
 * Useful for building UI hints and error messages.
 */
export function getAllowedTransitions(from: CaseStatus): readonly CaseStatus[] {
  return FSM_TRANSITIONS[from];
}

/**
 * Assert a transition is valid, returning a descriptive error string if not.
 * Returns null if the transition is valid.
 */
export function validateTransition(
  from: CaseStatus,
  to: CaseStatus
): string | null {
  if (from === to) {
    return `El caso ya está en estado '${from}'.`;
  }
  if (!isValidTransition(from, to)) {
    const allowed = FSM_TRANSITIONS[from];
    if (allowed.length === 0) {
      return `El estado '${from}' es terminal. No se permiten más transiciones.`;
    }
    return `No se puede pasar de '${from}' a '${to}'. Transiciones permitidas: ${allowed.join(", ")}.`;
  }
  return null; // valid
}
