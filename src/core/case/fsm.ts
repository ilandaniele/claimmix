/**
 * Case status FSM — finite-state machine for ClaimMix case statuses.
 *
 * Original transitions (FNOL simulate flow):
 *   procesando → listo | esperando | escalado
 *   listo      → cerrado | escalado
 *   esperando  → listo | escalado | cerrado
 *   escalado   → listo | cerrado
 *   cerrado    → (terminal — no transitions allowed)
 *
 * Email-intake transitions (added in W1 — IC6):
 *   recibido             → info_faltante | confirmacion_pendiente | requiere_especialista | listo_para_core | no_relevante
 *   info_faltante        → recibido | confirmacion_pendiente | requiere_especialista
 *   confirmacion_pendiente → recibido | listo_para_core | info_faltante | requiere_especialista
 *   requiere_especialista  → listo_para_core | cerrado
 *   listo_para_core      → enviado_a_core | error_core
 *   enviado_a_core       → cerrado
 *   error_core           → listo_para_core                            (retry)
 *   no_relevante         → (terminal — non-claim email)
 *
 * LLM08 containment:
 *   - AI worker CANNOT directly set terminal states ('cerrado', 'enviado_a_core', 'no_relevante').
 *   - AI worker sets 'recibido', 'info_faltante', 'requiere_especialista' only.
 *   - 'enviado_a_core' and 'cerrado' require explicit human POST/PATCH actions.
 *   - 'no_relevante' is set by the is_claim=false classifier path, not the AI directly.
 *     The worker sets it via a controlled server-side path, not the LLM output directly.
 *
 * OWASP API5: status updates go through this FSM — no arbitrary status writes.
 * AC16: FSM enforced in code; invalid transitions return 400 INVALID_FSM_TRANSITION.
 */

import type { CaseStatus } from "@/lib/schemas/cases";

/**
 * Allowed next statuses for each current status.
 * An empty array means terminal — no further transitions.
 *
 * Record is indexed by CaseStatus which is now the full union
 * (legacy + email-intake statuses).
 */
export const FSM_TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  // ── Original FNOL statuses ─────────────────────────────────────────────────
  procesando: ["listo", "esperando", "escalado"],
  listo: ["cerrado", "escalado"],
  esperando: ["listo", "escalado", "cerrado"],
  escalado: ["listo", "cerrado"],
  cerrado: [], // terminal

  // ── Email-intake statuses (IC6) ────────────────────────────────────────────
  /**
   * recibido: email received and persisted, extraction worker dispatched.
   * Can proceed to info_faltante (missing data), confirmacion_pendiente (medium confidence),
   * requiere_especialista (high severity), listo_para_core (all data good), or no_relevante.
   *
   * LLM08: AI worker may set this status (it is the initial email-intake state).
   */
  recibido: [
    "info_faltante",
    "confirmacion_pendiente",
    "requiere_especialista",
    "listo_para_core",
    "no_relevante",
  ],

  /**
   * info_faltante: required fields are missing; auto-reply sent requesting info.
   * Transitions back to recibido when a reply email arrives (IC10).
   * May also go directly to confirmacion_pendiente if medium-confidence fields found.
   *
   * LLM08: AI worker may set this status after gap analysis.
   */
  // requiere_especialista included: a reply can reveal an injury or a fire the
  // first message never mentioned, and a claim that turns out to be serious
  // must be able to escalate rather than stay parked because of where it
  // started.
  // `cerrado` is the abandonment exit: we asked, nobody answered, and the
  // nightly sweep gives up. Without it a conversation nobody is having stays
  // on the board forever.
  info_faltante: ["recibido", "confirmacion_pendiente", "requiere_especialista", "cerrado"],

  /**
   * confirmacion_pendiente: one or more fields need analyst confirmation.
   * After confirmation, case may have more missing info (→ info_faltante),
   * be ready (→ listo_para_core), or return to recibido for re-extraction.
   *
   * LLM08: AI worker may set this status after confidence scoring.
   */
  confirmacion_pendiente: [
    "recibido",
    "listo_para_core",
    "info_faltante",
    "requiere_especialista",
    "cerrado",
  ],

  /**
   * requiere_especialista: high severity signals detected; specialist needed.
   * Specialist reviews the case, then either clears it for core sync or closes.
   *
   * LLM08: AI worker may set this status based on severity classification.
   */
  requiere_especialista: ["listo_para_core", "cerrado"],

  /**
   * listo_para_core: all required fields confirmed; ready to sync with core system.
   * CoreSyncService is called explicitly via POST /api/cases/:id/sync-to-core.
   *
   * LLM08: AI worker may NOT set this directly when requires_specialist=true.
   *        Human action (confirm-field or specialist sign-off) is required first.
   */
  listo_para_core: ["enviado_a_core", "error_core"],

  /**
   * enviado_a_core: CoreSyncService.send() succeeded; core_external_id populated.
   * Can only proceed to cerrado (human close action).
   *
   * LLM08: AI worker CANNOT set this — only the sync-to-core route can.
   */
  enviado_a_core: ["cerrado"],

  /**
   * error_core: CoreSyncService.send() failed; core_error_message populated.
   * Analyst can retry (→ listo_para_core) which re-triggers the sync.
   *
   * LLM08: AI worker CANNOT set this — only the sync-to-core route can.
   */
  error_core: ["listo_para_core"],

  /**
   * no_relevante: email classified as not an insurance claim (is_claim=false).
   * Terminal state — no follow-up email sent, no further transitions.
   *
   * LLM08: The controlled server-side path (not the LLM output directly) sets this.
   */
  no_relevante: [], // terminal
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

/**
 * Returns true if the given status is a terminal state (no further transitions).
 */
export function isTerminalStatus(status: CaseStatus): boolean {
  return FSM_TRANSITIONS[status].length === 0;
}

/**
 * Email-intake specific: returns the initial status for a new email case.
 * This is 'recibido' — the email has been received and persisted.
 */
export const EMAIL_INITIAL_STATUS: CaseStatus = "recibido";

/**
 * Statuses that the AI worker is allowed to set directly.
 * Enforces LLM08: AI cannot set terminal states or core-sync states.
 */
export const AI_ALLOWED_STATUSES: ReadonlySet<CaseStatus> = new Set<CaseStatus>([
  "recibido",
  "info_faltante",
  "confirmacion_pendiente",
  "requiere_especialista",
  "no_relevante",
  // Legacy statuses the worker may still set (simulate flow)
  "listo",
  "esperando",
  "escalado",
]);

/**
 * Check whether a status is one that the AI worker may set.
 * Prevents LLM08 violations — AI cannot close a case or send it to core.
 */
export function isAiAllowedStatus(status: CaseStatus): boolean {
  return AI_ALLOWED_STATUSES.has(status);
}

export type { CaseStatus };
export type CaseStatusEmail = Extract<
  CaseStatus,
  | "recibido"
  | "info_faltante"
  | "confirmacion_pendiente"
  | "requiere_especialista"
  | "listo_para_core"
  | "enviado_a_core"
  | "error_core"
  | "no_relevante"
>;
