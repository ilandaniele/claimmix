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

import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import type { AuditLogInsert } from "@/lib/db/types";
import type { AuditPayload } from "./redact";
import { enTenant } from "@/data/scope";

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
    const insertRow: AuditLogInsert = {
      tenant_id: entry.tenant_id,
      actor_id: entry.actor_id ?? null,
      event_type: entry.event_type,
      target_type: entry.target_type ?? null,
      target_id: entry.target_id ?? null,
      payload: entry.payload ?? {},
      ip: entry.ip ?? null,
      ua: entry.ua ?? null,
    };

    await enTenant({ tenantId: insertRow.tenant_id }, (db) =>
      db.insert(auditLog).values(insertRow)
    );
  } catch (err) {
    // Log the error code/name only — never the full error (may contain PII).
    const code = (err as { code?: string })?.code;
    if (code) {
      console.error("[audit] Failed to write audit log:", code);
    } else {
      const errName = err instanceof Error ? err.name : "UnknownError";
      console.error("[audit] Exception writing audit log:", errName);
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
  USER_ROLE_CHANGED: "auth.user_role_changed",
  PASSWORD_RESET_REQUESTED: "auth.password_reset_requested",
  PASSWORD_RESET_COMPLETED: "auth.password_reset_completed",

  // ── Case lifecycle ─────────────────────────────────────────────────────────
  CASE_CREATED: "case.created",
  CASE_STATUS_CHANGED: "case.status_changed",
  CASE_CLOSED: "case.closed",
  CASE_ASSIGNED: "case.assigned",

  // ── AI extraction ──────────────────────────────────────────────────────────
  AI_EXTRACTED: "ai.extracted",
  AI_BUDGET_EXCEEDED: "ai.budget_exceeded",
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
   * arrancar, así que no se leyó. Payload: { status, motivo }.
   *
   * `no_relevante` y `listo_para_core` son terminales en la máquina de estados
   * —`no_relevante` a propósito, bajo LLM08: la IA no saca un caso de un estado
   * terminal— y el worker tiene una lista de estados desde los que puede
   * empezar. Cuando llega un mensaje a un caso que quedó afuera de esa lista, el
   * mensaje se guarda y NO se lee.
   *
   * Alguien escribe «hola», el clasificador dice que no es una denuncia, y
   * después escribe la denuncia de verdad: eso queda sin leer. Abrir la máquina
   * de estados es una decisión de producto; que el silencio deje de ser silencio
   * no lo es.
   */
  MESSAGE_NOT_READ: "claim.message_not_read",

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
   * CASE_CLOSED_ABANDONED: the claimant never answered and the conversation
   * was closed by the nightly sweep.
   * Payload: { case_id, after_days, reason }.
   *
   * Distinct from a human closing a case: this one says nobody decided
   * anything, time simply ran out.
   */
  CASE_CLOSED_ABANDONED: "claim.closed_abandoned",

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
} as const;

export type AuditEventType = (typeof AuditEvent)[keyof typeof AuditEvent];
