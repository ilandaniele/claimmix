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
 *   no_relevante         → recibido                              (llegó un mensaje nuevo)
 *
 * LLM08 containment:
 *   - AI worker CANNOT directly set terminal states ('cerrado', 'enviado_a_core', 'no_relevante').
 *   - Ni sacar un caso de 'no_relevante': la única arista que sale de ahí la
 *     toma el camino de ingreso cuando llega un mensaje, no el modelo.
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
   *
   * Casi terminal: la ÚNICA salida es volver al principio del flujo cuando llega
   * un mensaje nuevo.
   *
   * Era terminal del todo, y eso significaba que alguien podía escribir «hola»,
   * quedar clasificado como no-denuncia, y mandar después la denuncia de verdad
   * sin que nadie la leyera: el worker no arranca desde acá, así que el mensaje
   * entraba, se guardaba, y se perdía adentro. En un producto de intake es la
   * peor forma de fallar. Y es el balde más grande de la base — 329 casos.
   *
   * LLM08 sigue en pie: esta arista NO la puede tomar el modelo. La toma
   * `reabrirSiEraNoRelevante`, en el camino de ingreso, disparada por el hecho
   * de que una persona mandó un mensaje. Es la simétrica de cómo se ENTRA a este
   * estado: por un camino controlado del servidor, no por la salida del LLM.
   *
   * Vuelve a `recibido` y no a otra cosa: es el principio del flujo normal, y si
   * el mensaje nuevo tampoco es una denuncia la extracción lo devuelve acá.
   */
  no_relevante: ["recibido"],
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
 * Estados que una persona NO reabre a mano desde el panel.
 *
 * No es lo mismo que `isTerminalStatus`, y separarlos costó una regresión: la
 * ruta de re-análisis preguntaba «¿es terminal?» para expresar una regla de
 * PERMISOS —«un analista común no reabre un caso cerrado»—. Cuando
 * `no_relevante` dejó de ser terminal del todo, la guarda se evaporó y cualquier
 * analista pasó a poder re-analizarlo. Lo cazó un test que ya existía.
 *
 * Son dos preguntas distintas:
 *   · `isTerminalStatus` — ¿la máquina de estados deja salir de acá?
 *   · esto             — ¿deja que lo saque una persona desde la pantalla?
 *
 * `no_relevante` tiene UNA salida, y la toma el camino de ingreso cuando llega
 * un mensaje. Que exista esa arista no habilita a un analista a usarla con un
 * clic; para eso está el caso especial de admin que la ruta ya tenía escrito.
 */
export const ESTADOS_QUE_NO_SE_REABREN_A_MANO: ReadonlySet<CaseStatus> =
  new Set<CaseStatus>([
    ...(Object.keys(FSM_TRANSITIONS) as CaseStatus[]).filter((s) =>
      isTerminalStatus(s)
    ),
    "no_relevante",
  ]);

/**
 * Email-intake specific: returns the initial status for a new email case.
 * This is 'recibido' — the email has been received and persisted.
 */
export const EMAIL_INITIAL_STATUS: CaseStatus = "recibido";

/**
 * Los estados que significan «el agente lo completó sin que interviniera nadie».
 *
 * Existe porque las métricas contaban `status = 'listo'` a secas, y en el
 * producto real NINGÚN caso llega a `listo`: ese es el vocabulario viejo, el que
 * usa el flujo simulado. El intake por correo y por WhatsApp termina en
 * `listo_para_core`. Con 28 casos completados en la base, la pantalla de
 * métricas mostraba «Tasa de completitud automática: 0%» — un producto que
 * funciona, mostrándose roto a quien lo está evaluando.
 *
 * Los dos vocabularios juntos a propósito: las filas viejas siguen contando.
 *
 * `enviado_a_core` cuenta: un caso que se completó solo y ADEMÁS ya se exportó
 * sigue siendo un caso que se completó solo. Sin él, el número bajaría a medida
 * que los casos avanzan, que es otra forma del mismo error.
 *
 * `cerrado` NO cuenta: ahí adentro están también los que se cierran por
 * abandono, que es lo contrario de completarse solo.
 */
export const ESTADOS_COMPLETADO_SIN_PERSONA: ReadonlySet<CaseStatus> =
  new Set<CaseStatus>(["listo", "listo_para_core", "enviado_a_core"]);

/**
 * Los estados que significan «esto lo tiene que mirar una persona».
 *
 * Mismo problema que arriba: se contaba `escalado`, que el canal real nunca
 * escribe. Son 43 en `requiere_especialista` y la pantalla decía 0.
 *
 * Cuenta el estado ACTUAL, así que un caso escalado y después cerrado deja de
 * sumar. Es una propiedad de contar por estado y no un descuido; para «cuántos
 * se escalaron alguna vez» haría falta mirar la auditoría.
 */
export const ESTADOS_ESCALADO: ReadonlySet<CaseStatus> =
  new Set<CaseStatus>(["escalado", "requiere_especialista"]);

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
