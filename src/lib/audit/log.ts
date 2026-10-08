/**
 * Audit log writer for ClaimMix.
 *
 * Every mutation writes an immutable row to audit_log.
 * Writes go through the shared Drizzle db handle (Neon) — audit writes
 * succeed even for system events where there is no authenticated user.
 *
 * PII rules:
 * - Never include DNI, license plates, policy numbers, or full names in payload.
 * - Use redactObject() from audit/redact.ts before building the payload.
 * - IP and UA are captured for forensic purposes but are not logged to stdout.
 *
 * AC1: audit log row inserted on auth.success.
 * AC3: audit log row inserted on auth.rate_limited.
 */

import { isIP } from "node:net";
import { auditLog } from "@/lib/db/schema";
import type { AuditLogInsert } from "@/lib/db/types";
import type { AuditPayload } from "./redact";
import { enTenant } from "@/data/scope";
import { logger } from "@/lib/observability/logger";

/**
 * `getClientIp` puede devolver "anonymous", que no es un `inet` válido y
 * tiraría abajo la escritura de auditoría.
 */
export function ipValida(ip?: string | null): string | null {
  return ip && isIP(ip) !== 0 ? ip : null;
}

export interface AuditLogEntry {
  tenant_id: string;
  actor_id?: string | null;
  event_type: string;
  target_type?: string | null;
  target_id?: string | null;
  payload?: AuditPayload;
  ip?: string | null;
  ua?: string | null;
}

/**
 * La fila de `audit_log` que corresponde a una entrada. Aparte de
 * `writeAuditLog` para que quien escribe dentro de una transacción propia (el
 * padrón importa cientos de filas de un solo viaje) pueda meterla en el mismo
 * lote en vez de auditar por fuera, donde un fallo dejaría la importación sin
 * rastro.
 */
export function filaDeAuditoria(entry: AuditLogEntry): AuditLogInsert {
  return {
    tenant_id: entry.tenant_id,
    actor_id: entry.actor_id ?? null,
    event_type: entry.event_type,
    target_type: entry.target_type ?? null,
    target_id: entry.target_id ?? null,
    payload: entry.payload ?? {},
    ip: ipValida(entry.ip),
    ua: entry.ua ?? null,
  };
}

/**
 * Write an audit log entry.
 *
 * Uses the shared db handle so the write succeeds regardless of
 * the current auth context (system events, failed auth, etc.).
 *
 * Failures are logged to stderr but never thrown — audit log writes
 * must never break the primary request flow.
 */
export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
    const insertRow = filaDeAuditoria(entry);

    await enTenant({ tenantId: insertRow.tenant_id }, (db) =>
      db.insert(auditLog).values(insertRow)
    );
  } catch (err) {
    // Log the error code/name only — never the full error (may contain PII).
    const code = (err as { code?: string })?.code;
    if (code) {
      logger.error({ code }, "audit.failed_to_write_audit_log");
    } else {
      const errName = err instanceof Error ? err.name : "UnknownError";
      logger.error({ error_name: errName }, "audit.exception_writing_audit_log");
    }
  }
}

/** Common event type constants — prevents typo drift across the codebase. */
export const AuditEvent = {
  // ── Authentication ─────────────────────────────────────────────────────────
  AUTH_SUCCESS: "auth.success",
  AUTH_FAILURE: "auth.failure",
  AUTH_SIGN_OUT: "auth.sign_out",
  AUTH_RATE_LIMITED: "auth.rate_limited",
  AUTH_SIGN_UP: "auth.sign_up",
  /** USER_CREATED: un admin dio de alta a otra persona desde el panel. */
  USER_CREATED: "auth.user_created",
  USER_ROLE_CHANGED: "auth.user_role_changed",
  PASSWORD_RESET_REQUESTED: "auth.password_reset_requested",
  PASSWORD_RESET_COMPLETED: "auth.password_reset_completed",
  /**
   * USER_SESSIONS_REVOKED: un admin cerró todas las sesiones de otra persona.
   * Payload: { sesiones_cerradas }. El actor es el admin; el objetivo, el usuario.
   */
  USER_SESSIONS_REVOKED: "auth.user_sessions_revoked",

  // ── Case lifecycle ─────────────────────────────────────────────────────────
  CASE_CREATED: "case.created",
  CASE_STATUS_CHANGED: "case.status_changed",
  CASE_CLOSED: "case.closed",
  CASE_ASSIGNED: "case.assigned",
  /**
   * CASE_DELETED: alguien borró un caso.
   *
   * La única operación irreversible del producto era la única sin registro de
   * quién la hizo: ninguna de las dos rutas de DELETE escribía auditoría, y no
   * había evento que escribir.
   *
   * Sobrevive al borrado a propósito: `audit_log.target_id` NO es una clave
   * foránea, y el comentario del esquema dice que es justamente para esto. El
   * rastro quedaba disponible y nunca se usaba.
   */
  CASE_DELETED: "case.deleted",
  /** Una persona contestó lo que llegó después de que el agente terminó. */
  CASE_MARKED_ANSWERED: "case.marked_answered",
  /**
   * CASE_HUMAN_REPLY: una persona respondió por WhatsApp desde el caso, sin
   * pasar por el agente. Payload: { outbound_id, estado } — nunca el texto.
   */
  CASE_HUMAN_REPLY: "case.human_reply",
  /** CASE_READY_CONFIRMED: una persona confirmó que el caso queda listo para Core. */
  CASE_READY_CONFIRMED: "case.ready_confirmed",

  // ── AI extraction ──────────────────────────────────────────────────────────
  AI_EXTRACTED: "ai.extracted",
  AI_BUDGET_EXCEEDED: "ai.budget_exceeded",
  /**
   * AI_BUDGET_ALERTED: se avisó a los especialistas de que el presupuesto de IA
   * se agotó y las denuncias dejaron de analizarse. Va aparte de
   * AI_BUDGET_EXCEEDED, que es uno por mensaje sin analizar; éste, uno por aviso.
   * Payload: { motivo, recipients, delivered }. El objetivo es el inquilino.
   */
  AI_BUDGET_ALERTED: "ai.budget_alerted",
  AI_PROVIDER_CHANGED: "ai.provider_changed",

  // ── Document / gap analysis ────────────────────────────────────────────────
  DOC_RECEIVED: "doc.received",

  // ── Email intake (new in W1 — email claims intake workflow) ───────────────

  /**
   * EMAIL_RECEIVED: inbound email webhook processed successfully.
   * Emitted when a new email creates a case or appends to an existing thread.
   * AC1, AC4.
   */
  EMAIL_RECEIVED: "email.received",

  /**
   * EMAIL_FILTERED: inbound email was classified as clearly non-claim before
   * case creation, so no AI extraction was run.
   * Payload: { message_id, reason, category } -- no subject/body/from address.
   */
  EMAIL_FILTERED: "email.filtered",

  /**
   * WEBHOOK_REJECTED: HMAC signature verification failed.
   * Emitted before any DB write — no PII in payload.
   * AC2.
   */
  WEBHOOK_REJECTED: "email.webhook_rejected",

  /**
   * EMAIL_DEDUPLICATED: duplicate MessageID detected; request idempotently ignored.
   * Emitted when a case already exists for this (tenant_id, email_message_id) pair.
   * AC3.
   */
  EMAIL_DEDUPLICATED: "email.deduplicated",

  /**
   * EXTRACTION_STARTED: AI extraction worker has been dispatched.
   * Payload: { case_id, message_id } — no body text.
   * AC1.
   */
  EXTRACTION_STARTED: "ai.extraction_started",

  /**
   * EXTRACTION_COMPLETE: AI extraction worker finished successfully.
   * Payload: { case_id, is_claim, severity, missing_fields[] }.
   * AC1, AC5, AC6.
   */
  EXTRACTION_COMPLETE: "ai.extraction_complete",

  /**
   * CONFIRMATION_REQUESTED: analyst must confirm a medium-confidence or conflicting field.
   * AC7, AC9.
   *
   * Dos formas de payload, según de dónde venga:
   *   · `{ field_keys: string[] }` — el pedido de confirmación por campos
   *     dudosos, que se anota UNA vez con todas las claves. Antes era un evento
   *     por campo, que es la misma información repetida N veces sobre el mismo
   *     caso en el mismo instante.
   *   · `{ field_key, reason: "conflict" }` — un conflicto con los datos que ya
   *     tenemos del cliente, que sí es un evento por campo porque cada uno tiene
   *     su propio motivo.
   *
   * En ninguna de las dos va el valor: es dato de una persona.
   */
  CONFIRMATION_REQUESTED: "claim.confirmation_requested",

  /**
   * MISSING_INFO_REQUESTED: auto-reply sent listing missing required fields.
   * Payload: { case_id, missing_fields[] }.
   * AC10.
   */
  MISSING_INFO_REQUESTED: "claim.missing_info_requested",

  /**
   * MESSAGE_NOT_READ: llegó un mensaje a un caso del que el worker no vuelve a
   * arrancar, así que no se leyó. Payload: { status, motivo }; el mail pasado el
   * tope por remitente lleva { motivo: "tope_por_remitente", channel }, y el
   * formulario web pasado su tope diario, { motivo: "tope_por_formulario", channel: "web" }.
   *
   * `no_relevante` y `listo_para_core` no son estados de arranque del worker
   * —`no_relevante` a propósito, bajo LLM08: la IA no saca un caso de ahí; de
   * `listo_para_core` lo saca sync-to-core o una persona (`SALIDAS_A_MANO`)— y
   * el worker tiene una lista de estados desde los que puede empezar. Cuando llega un mensaje a un caso que quedó afuera de esa lista, el
   * mensaje se guarda y NO se lee.
   *
   * Alguien escribe «hola», el clasificador dice que no es una denuncia, y
   * después escribe la denuncia de verdad: eso queda sin leer. Abrir la máquina
   * de estados es una decisión de producto; que el silencio deje de ser silencio
   * no lo es.
   */
  MESSAGE_NOT_READ: "claim.message_not_read",

  /**
   * CASE_REOPENED: un caso que estaba dado por no-relevante volvió al flujo
   * porque llegó un mensaje nuevo. Payload: { desde, motivo }.
   *
   * Queda asentado porque es la única transición que sale de un estado que la
   * máquina trata como final, y porque desde afuera un caso reabierto se ve
   * igual que uno que nunca se cerró.
   */
  CASE_REOPENED: "claim.case_reopened",

  /**
   * SPECIALIST_REQUIRED: case escalated to specialist due to high severity.
   * Payload: { case_id, severity }.
   * AC11.
   */
  SPECIALIST_REQUIRED: "claim.specialist_required",

  /**
   * SPECIALIST_ALERTED: a human was actually told the case is waiting.
   * Payload: { case_id, recipients, delivered }.
   *
   * Distinct from SPECIALIST_REQUIRED, which only records that the case
   * changed status. The claimant is promised someone will call; this is the
   * line that proves anyone was asked to.
   */
  SPECIALIST_ALERTED: "claim.specialist_alerted",

  /**
   * LATE_MESSAGE_CLASSIFIED: el worker clasificó un mensaje que llegó después
   * de que el agente terminó. Payload: { message_id, tipo } — nunca el texto;
   * tipo null es «sin clasificar».
   */
  LATE_MESSAGE_CLASSIFIED: "claim.late_message_classified",

  /**
   * LATE_MESSAGE_ALERTED: se avisó a los especialistas de ese mensaje.
   * Payload: { message_id, recipients, delivered }. Propio y no
   * SPECIALIST_ALERTED: el aviso de la derivación es uno por caso, éste uno por
   * mensaje.
   */
  LATE_MESSAGE_ALERTED: "claim.late_message_alerted",

  /**
   * WORKSHOP_ESTIMATE_READ: alguien del equipo pidió leer el presupuesto de
   * taller de un adjunto (B21). Payload: { attachment_id, leido, motivo,
   * alertas } — nunca los ítems ni los importes.
   */
  WORKSHOP_ESTIMATE_READ: "claim.workshop_estimate_read",

  /**
   * POLICY_CONDITIONS_UPLOADED: alguien subió las condiciones de una póliza
   * (B6). Payload: { policy_id, leido, motivo } — nunca lo que dice el PDF.
   */
  POLICY_CONDITIONS_UPLOADED: "policy.conditions_uploaded",

  /**
   * AMOUNT_RANGES_CHANGED: un admin cambió la tabla de montos orientativos
   * desde /configuracion (B23). Payload: { por_defecto } — nunca los montos.
   */
  AMOUNT_RANGES_CHANGED: "tenant.amount_ranges_changed",

  /**
   * CASE_PLAN_CREATED: el caso recibió su plan de trabajo (B11). Payload:
   * { pasos, origen } — nunca los títulos.
   */
  CASE_PLAN_CREATED: "case.plan_created",

  /**
   * CASE_PLAN_STEP: un paso del plan se tildó o se destildó (B11). Payload:
   * { clave, hecho, auto: true } si lo tildó el paso de estado, o
   * { clave, hecho, origen: "manual" } si lo hizo una persona (el actor va aparte).
   */
  CASE_PLAN_STEP: "case.plan_step",

  /**
   * TENANT_WORK_SETTINGS_UPDATED: un admin cambió cómo trabaja el equipo
   * (reglas de asignación, plazos, plan o pesos del puntaje) desde /agente.
   * Payload: { campo, antes, despues }: las configuraciones, no datos de casos.
   */
  TENANT_WORK_SETTINGS_UPDATED: "tenant.work_settings_updated",

  /**
   * SPECIALIST_ALERT_RECIPIENTS_CHANGED: an admin edited the tenant's list of
   * addresses for urgent-case alerts, from /configuracion.
   * Payload: { count }. Never the addresses themselves.
   * Targets a tenant, not a case: it needs no `audit.*` key.
   */
  SPECIALIST_ALERT_RECIPIENTS_CHANGED: "tenant.specialist_alert_recipients_changed",

  /**
   * CORE_SETTINGS_CHANGED: an admin changed the delivery to the insurer's core
   * system from /configuracion (B5). Payload: booleans only — url_cambiada,
   * enabled, secreto_generado, clave_rotada, clave_revocada. Never the URL, the
   * secret or the key.
   */
  CORE_SETTINGS_CHANGED: "tenant.core_settings_changed",

  /**
   * CORE_WEBHOOK_TESTED: an admin sent the synthetic test payload to the
   * webhook. Payload: { ok, motivo }. No case is involved.
   */
  CORE_WEBHOOK_TESTED: "tenant.core_webhook_tested",

  /**
   * CASE_CLOSED_ABANDONED: the claimant never answered and the conversation
   * was closed by the nightly sweep.
   * Payload: { case_id, after_days, reason }.
   *
   * Distinct from a human closing a case: this one says nobody decided
   * anything, time simply ran out.
   */
  CASE_CLOSED_ABANDONED: "claim.closed_abandoned",

  /** CLAIM_REQUEST_RESENT: una persona volvió a pedirle al asegurado lo que falta. */
  CLAIM_REQUEST_RESENT: "claim.request_resent",

  /**
   * CLAIM_REMINDER_SENT / SKIPPED / FAILED: el recordatorio automático del
   * pedido. Payload: { etapa, horas, canal, via } al mandarlo; { etapa, reason }
   * al saltearlo; { etapa, canal } si falla. La etapa queda gastada en los tres.
   */
  CLAIM_REMINDER_SENT: "claim.reminder_sent",
  CLAIM_REMINDER_SKIPPED: "claim.reminder_skipped",
  CLAIM_REMINDER_FAILED: "claim.reminder_failed",

  /**
   * CASE_CLOSURE_NOTICE_SENT / SKIPPED / FAILED: el aviso al asegurado de que
   * su caso se cerró por falta de respuesta. Payload: { canal }, { reason } o
   * { code }. Sale una vez: la etapa 9 queda gastada en los tres.
   */
  CASE_CLOSURE_NOTICE_SENT: "claim.closure_notice_sent",
  CASE_CLOSURE_NOTICE_SKIPPED: "claim.closure_notice_skipped",
  CASE_CLOSURE_NOTICE_FAILED: "claim.closure_notice_failed",

  /**
   * DOCUMENTS_RECEIVED: a file the claimant sent was recognised as one of the
   * documents we had asked for, and the request was closed.
   * Payload: { case_id, doc_keys }.
   *
   * Worth its own event because the decision was the model's: if a document is
   * ever closed wrongly, this is the line that says when and which.
   */
  DOCUMENTS_RECEIVED: "claim.documents_received",

  /**
   * DOCUMENTS_DECLINED: the claimant said one of the documents we asked for
   * does not exist. Payload: { case_id, doc_keys, note }.
   *
   * Never merged into DOCUMENTS_RECEIVED. Nothing arrived, and an analyst who
   * sees "received" will assume there is a file to open. Also the model's
   * decision, so the same reasoning applies: if a request is ever waived
   * wrongly, this is the line that says when and on the strength of what.
   */
  DOCUMENTS_DECLINED: "claim.documents_declined",

  /**
   * AGENT_DELIBERATED: the agent decided what to do about an inbound message.
   * Payload: { intent, ask_for, question, reasoning }.
   *
   * The only place the "why" is written down. Everything the agent says is now
   * a decision it made rather than a branch someone wrote, and an operation
   * that cannot answer "why did it say that" cannot be sold to an insurer.
   */
  AGENT_DELIBERATED: "agent.deliberated",

  /**
   * AGENT_NOTE: something the agent thought an analyst should know and no
   * field captures. Payload: { note }.
   *
   * "El otro conductor se dio a la fuga", "menciona un abogado", "dice que ya
   * reclamó por esto en marzo". A person handling the file writes these down;
   * a schema was never going to have a column for them.
   */
  AGENT_NOTE: "agent.note",

  /**
   * DELIVERY_TEST: someone asked the deployment to send a real test message.
   * Payload: { channel, ok, detail }.
   *
   * A real message went to a real person, so it belongs in the record like
   * anything else we send — and it is what the rate limit reads to know a test
   * already went out this minute.
   */
  DELIVERY_TEST: "health.delivery_test",

  /**
   * FIELD_CONFIRMED: analyst confirmed or corrected an extracted field.
   * Payload: { case_id, field_key, action, old_value_redacted, new_value_redacted }.
   * AC21.
   */
  FIELD_CONFIRMED: "claim.field_confirmed",

  /**
   * FIELD_REJECTED: analyst rejected a proposed field value.
   * Payload: { case_id, field_key }.
   * AC21.
   */
  FIELD_REJECTED: "claim.field_rejected",

  /**
   * MEMORY_APPLIED: claim_memory hints injected into extraction prompt.
   * Payload: { case_id, sender_email_redacted, fields_applied[] }.
   * AC13.
   */
  MEMORY_APPLIED: "memory.applied",

  /**
   * CORE_SYNC_SUCCESS: CoreSyncService.send() completed successfully.
   * Payload: { case_id, core_external_id }.
   * AC17.
   */
  CORE_SYNC_SUCCESS: "core.sync_success",

  /**
   * CORE_SYNC_FAILED: CoreSyncService.send() returned an error.
   * Payload: { case_id, error_code }.
   * AC17.
   */
  CORE_SYNC_FAILED: "core.sync_failed",

  /**
   * OUTBOUND_EMAIL_SENT: Outbound email provider successfully delivered an email.
   * Payload: { case_id, subject_prefix } — no To address (PII).
   * AC12.
   */
  OUTBOUND_EMAIL_SENT: "email.outbound_sent",

  /**
   * OUTBOUND_EMAIL_FAILED: Outbound email provider failed to deliver an email.
   * Payload: { case_id, error } — no To address (PII).
   * AC12.
   */
  OUTBOUND_EMAIL_FAILED: "email.outbound_failed",

  /**
   * ATTACHMENT_REHOSTED: Attachment successfully uploaded to object storage.
   * Payload: { storage_path, size_bytes, content_hash_prefix } — first 12 hex chars only.
   * AC7.
   */
  ATTACHMENT_REHOSTED: "attachment.rehosted",

  /**
   * ATTACHMENT_REJECTED: Attachment rejected due to content-type, size, or other validation failure.
   * Payload: { reason, size_bytes }.
   * AC8, AC9.
   */
  ATTACHMENT_REJECTED: "attachment.rejected",

  // ── Agent learning & review workflow ───────────────────────────────────────

  /**
   * TRAINING_EXAMPLE_APPROVED: a human confirmed an agent run as a safe
   * training example ("Confirm as safe training example" button).
   * Payload: { case_id, agent_run_id, training_example_id } — no email content.
   */
  TRAINING_EXAMPLE_APPROVED: "training.example_approved",

  /**
   * TRAINING_EXAMPLE_REJECTED: approval was attempted but blocked (duplicate,
   * unsafe run, or missing agent run). Payload: { case_id, reason }.
   */
  TRAINING_EXAMPLE_REJECTED: "training.example_rejected",

  /**
   * PROMPT_RULE_CREATED / UPDATED / TOGGLED: operator-authored agent prompt
   * rules changed in the Agent Training Console.
   * Payload: { rule_id, rule_type, active } — rule text NOT included.
   */
  PROMPT_RULE_CREATED: "training.prompt_rule_created",
  PROMPT_RULE_UPDATED: "training.prompt_rule_updated",
  PROMPT_RULE_TOGGLED: "training.prompt_rule_toggled",
  CUSTOM_FIELD_CREATED: "training.custom_field_created",
  CUSTOM_FIELD_UPDATED: "training.custom_field_updated",
  CUSTOM_FIELD_TOGGLED: "training.custom_field_toggled",

  /**
   * FINETUNE_JOB_QUEUED: enough approved examples accumulated — a draft
   * model_training_jobs row was created (batch fine-tuning, never automatic).
   * Payload: { job_id, training_example_count }.
   */
  FINETUNE_JOB_QUEUED: "training.finetune_job_queued",
  FINETUNE_JOB_STARTED: "training.finetune_job_started",
  FINETUNE_JOB_SYNCED: "training.finetune_job_synced",
  FINETUNE_JOB_APPROVED: "training.finetune_job_approved",
  FINETUNE_MODEL_DEPLOYED: "training.finetune_model_deployed",
  FINETUNE_MODEL_ROLLED_BACK: "training.finetune_model_rolled_back",
  AGENT_MEMORY_CONFIG_EXPORTED: "agent.memory_config_exported",

  /**
   * AGENT_DELIBERATION_FAILED: la deliberación tiró — 429, MAX_TOKENS, un
   * JSON que no parseó. Payload: { status, code, error_name }.
   *
   * El catch ya lo mandaba al log de Vercel y ahí se quedaba: nada en
   * `audit_log` decía que una decisión se cayó al árbol determinístico ni
   * cuántas veces. Sin esto, un 429 sostenido es indistinguible de que el
   * agente nunca deliberó nada raro.
   */
  AGENT_DELIBERATION_FAILED: "agent.deliberation_failed",

  /**
   * ASSISTANT_QUERY: alguien le hizo una pregunta al asistente in-app.
   * Payload: { herramienta, casos } — nunca la pregunta ni el texto de la
   * respuesta: son texto libre de quien pregunta y del modelo.
   */
  ASSISTANT_QUERY: "assistant.query",

  /**
   * RAMO_PROPIO_GUARDADO / RAMO_PROPIO_BORRADO: un admin creó, cambió o borró un
   * tipo de siniestro propio (B26). Payload: { clave } — nunca los nombres.
   */
  RAMO_PROPIO_GUARDADO: "tenant.ramo_guardado",
  RAMO_PROPIO_BORRADO: "tenant.ramo_borrado",

  /**
   * FORMULARIO_WEB_CAMBIADO: un admin creó el formulario público o lo encendió
   * o apagó (B17). El enlace se fija al crearlo y no cambia después. Payload:
   * { activo } — nunca el enlace.
   */
  FORMULARIO_WEB_CAMBIADO: "tenant.formulario_web_cambiado",

  /**
   * DENUNCIA_WEB_RECIBIDA: llegó una denuncia por el formulario público (B17).
   * Va sin actor: quien la manda no tiene cuenta. Payload: { canal } — nada de
   * lo que escribió la persona.
   */
  DENUNCIA_WEB_RECIBIDA: "case.web_recibida",

  /**
   * PADRON_IMPORTADO: alguien confirmó una importación del padrón (B16).
   * Payload: { clientes: { altas, cambios }, polizas: { altas, cambios } } —
   * sólo cuántos, nunca una fila.
   */
  PADRON_IMPORTADO: "padron.importado",
  /**
   * CLIENTE_ALTA / CLIENTE_CAMBIO / POLIZA_ALTA / POLIZA_CAMBIO: alta o edición
   * manual desde /clientes (B16). Payload: { campos } — los nombres de lo que
   * cambió, nunca los valores.
   */
  CLIENTE_ALTA: "customer.created",
  CLIENTE_CAMBIO: "customer.updated",
  POLIZA_ALTA: "policy.created",
  POLIZA_CAMBIO: "policy.updated",

  /**
   * SSO_CONFIGURADO: un admin guardó el IdP de su aseguradora (B19).
   * Payload: { campos, secreto_cambiado } — los nombres de lo que cambió, nunca
   * el secreto ni el cifrado.
   */
  SSO_CONFIGURADO: "sso.configurado",
  /** SSO_DOMINIO_VERIFICADO: el TXT `_claimmix.<dominio>` apareció. Payload: { dominio }. */
  SSO_DOMINIO_VERIFICADO: "sso.dominio_verificado",
  /**
   * SSO_EXIGIDO: se prendió o se apagó «exigir SSO», o se prendió o apagó el
   * SSO. Payload: { activo, exigir, sesiones_cerradas }.
   */
  SSO_EXIGIDO: "sso.exigido",
  /**
   * SSO_INGRESO_JIT: alguien entró por SSO por primera vez y se le creó la
   * cuenta como viewer. Payload: {} — ni mail ni reclamos del IdP.
   */
  SSO_INGRESO_JIT: "sso.ingreso_jit",
  /**
   * SSO_RECHAZADO: el IdP devolvió a alguien y no se lo dejó entrar. Payload:
   * { motivo } — un código, nunca el token, el mail ni los reclamos.
   */
  SSO_RECHAZADO: "sso.rechazado",

  /**
   * ADJUNTOS_PURGADOS: la purga diferida borró de R2 los adjuntos de un caso
   * que ya no existe (B19). Va sin actor, sólo al borrar de verdad (el modo
   * simular no deja rastro). Payload: { purgados, fallidos } — sólo conteos,
   * sin paths.
   */
  ADJUNTOS_PURGADOS: "adjuntos.purgados",
  /**
   * RETENCION_APLICADA: la retención borró casos cerrados hace más de N años
   * (B19). Va sin actor, una por inquilino, sólo al borrar de verdad (el modo
   * simular no deja rastro). Payload: { anios, corte, candidatos, borrados } —
   * sólo conteos y la fecha de corte.
   */
  RETENCION_APLICADA: "retencion.aplicada",

  // ── Alta automática ────────────────────────────────────────────────────────
  /**
   * TENANT_CREATED: una aseguradora se dio de alta sola. Lo escribe
   * claimmix_crear_inquilino, en la misma transacción que el inquilino. Payload:
   * { origen, numero_en_revision } — nunca el mail ni el número.
   */
  TENANT_CREATED: "tenant.created",
  /** TENANT_PLAN_CHANGED: cambió el plan de un inquilino (payload { de, a, estado }) o se le extendió la prueba (payload { prueba_hasta }). */
  TENANT_PLAN_CHANGED: "tenant.plan_changed",
  /** TENANT_SUSPENDED: el operador suspendió o reactivó un inquilino. Payload: { estado }. */
  TENANT_SUSPENDED: "tenant.suspended",
  /** El número de WhatsApp de un inquilino quedó conectado, suspendido o dado de baja. */
  WHATSAPP_NUMERO_CONECTADO: "whatsapp.numero_conectado",
  WHATSAPP_NUMERO_SUSPENDIDO: "whatsapp.numero_suspendido",
  WHATSAPP_NUMERO_BAJA: "whatsapp.numero_baja",
  /** USER_INVITED: un admin invitó a una persona al espacio. Payload: { rol } — sin el mail. */
  USER_INVITED: "auth.user_invited",
  /** INVITATION_ACCEPTED: la persona invitada aceptó y se le creó el perfil. */
  INVITATION_ACCEPTED: "auth.invitation_accepted",
  /** INVITATION_REJECTED: la invitación no se pudo aceptar. Payload: { motivo } — un código. */
  INVITATION_REJECTED: "auth.invitation_rejected",
  /**
   * DESVIOS_ALERTED: se avisó a los especialistas de los desvíos nuevos que
   * dejó la revisión nocturna (B22). Uno por inquilino y por día, sin actor; el
   * objetivo es el inquilino, no un caso. Payload: { nuevos, <regla>: n, …,
   * recipients, delivered } — sólo conteos.
   */
  DESVIOS_ALERTED: "quality.desvios_alerted",
} as const;

export type AuditEventType = (typeof AuditEvent)[keyof typeof AuditEvent];
