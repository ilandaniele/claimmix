/**
 * Qué eventos de auditoría cuentan como «una persona tocó el caso».
 *
 * Es lo que separa «llegó a listo solo» de «llegó a listo con ayuda» (B15). El
 * criterio es la fila de auditoría de un evento de esta lista CON `actor_id`:
 * el mismo evento sin actor lo escribió el agente o un proceso, y no cuenta.
 * Por eso `case.status_changed` está en la lista: el cambio de estado que hace
 * el agente no trae actor, y el que hace alguien desde la pantalla sí.
 *
 * El `Record` es exhaustivo a propósito: un evento nuevo en `AuditEvent` no
 * compila hasta que alguien decide si es una intervención. Sin eso, el número
 * se corrompe en silencio cada vez que se agrega un evento.
 */

import type { AuditEventType } from "@/lib/audit/log";

export const ES_INTERVENCION: Readonly<Record<AuditEventType, boolean>> = {
  "auth.success": false,
  "auth.failure": false,
  "auth.sign_out": false,
  "auth.rate_limited": false,
  "auth.sign_up": false,
  "auth.user_created": false,
  "auth.user_role_changed": false,
  "auth.password_reset_requested": false,
  "auth.password_reset_completed": false,
  "auth.user_sessions_revoked": false,
  "auth.user_deactivated": false,
  "auth.user_reactivated": false,

  "case.created": false,
  "case.status_changed": true,
  "case.closed": true,
  "case.assigned": true,
  // Borrado: el caso ya no está para contarlo.
  "case.deleted": false,
  "case.marked_answered": true,
  "case.human_reply": true,
  "case.ready_confirmed": true,

  "ai.extracted": false,
  "ai.budget_exceeded": false,
  "ai.budget_alerted": false,
  "ai.provider_changed": false,

  "doc.received": false,

  "email.received": false,
  "email.filtered": false,
  "email.webhook_rejected": false,
  "email.deduplicated": false,

  "ai.extraction_started": false,
  "ai.extraction_complete": false,

  "claim.confirmation_requested": false,
  "claim.missing_info_requested": false,
  "claim.message_not_read": false,
  "claim.case_reopened": true,
  "claim.specialist_required": false,
  "claim.specialist_alerted": false,
  "claim.late_message_classified": false,
  "claim.late_message_alerted": false,
  "claim.late_message_split": false,
  "claim.opened_from_late_message": false,
  // Abrir el presupuesto lo pide una persona, pero es leer, no gestionar.
  "claim.workshop_estimate_read": false,
  // Bajar el JSON lo pide una persona, pero es leer, no gestionar.
  "case.exported_to_core": false,

  "policy.conditions_uploaded": false,
  "tenant.amount_ranges_changed": false,

  "case.plan_created": false,
  "case.plan_step": true,

  "tenant.work_settings_updated": false,
  "tenant.specialist_alert_recipients_changed": false,
  "tenant.core_settings_changed": false,
  "tenant.core_webhook_tested": false,

  "claim.closed_abandoned": false,
  "claim.request_resent": true,
  "claim.reminder_sent": false,
  "claim.reminder_skipped": false,
  "claim.reminder_failed": false,
  "claim.closure_notice_sent": false,
  "claim.closure_notice_skipped": false,
  "claim.closure_notice_failed": false,
  "claim.documents_received": false,
  "claim.documents_declined": false,

  "agent.deliberated": false,
  "agent.note": false,
  "health.delivery_test": false,

  "claim.field_confirmed": true,
  "claim.field_rejected": true,
  "memory.applied": false,

  "core.sync_success": false,
  "core.sync_failed": false,

  "email.outbound_sent": false,
  "email.outbound_failed": false,
  "attachment.rehosted": false,
  "attachment.rejected": false,

  "training.example_approved": false,
  "training.example_rejected": false,
  "training.prompt_rule_created": false,
  "training.prompt_rule_updated": false,
  "training.prompt_rule_toggled": false,
  "training.custom_field_created": false,
  "training.custom_field_updated": false,
  "training.custom_field_toggled": false,
  "training.finetune_job_queued": false,
  "training.finetune_job_started": false,
  "training.finetune_job_synced": false,
  "training.finetune_job_approved": false,
  "training.finetune_model_deployed": false,
  "training.finetune_model_rolled_back": false,
  "agent.memory_config_exported": false,
  "agent.deliberation_failed": false,

  "assistant.query": false,

  // Configuración, padrón y alta desde la web: no es gestionar un caso.
  "tenant.ramo_guardado": false,
  "tenant.ramo_borrado": false,
  "tenant.formulario_web_cambiado": false,
  "case.web_recibida": false,
  "padron.importado": false,
  "customer.created": false,
  "customer.updated": false,
  "policy.created": false,
  "policy.updated": false,

  // SSO y borrados programados: configuración y mantenimiento, no gestión de un caso.
  "sso.configurado": false,
  "sso.dominio_verificado": false,
  "sso.exigido": false,
  "sso.ingreso_jit": false,
  "sso.rechazado": false,
  "adjuntos.purgados": false,
  "retencion.aplicada": false,

  // Alta automática, planes, números de WhatsApp e invitaciones: del inquilino, no de un caso.
  "tenant.created": false,
  "tenant.plan_changed": false,
  "tenant.suspended": false,
  "whatsapp.numero_conectado": false,
  "whatsapp.numero_agregado": false,
  "whatsapp.numero_suspendido": false,
  "whatsapp.numero_baja": false,
  "whatsapp.waba_vinculada": false,
  "whatsapp.waba_revocada": false,
  "meta.borrado_de_datos": false,
  "whatsapp.app_acuerdo": false,
  "whatsapp.app_credenciales": false,
  "whatsapp.app_legales_despublicadas": false,
  "auth.user_invited": false,
  "auth.invitation_accepted": false,
  "auth.invitation_rejected": false,
  // Aviso de la revisión nocturna al inquilino: lo manda el sistema, no gestiona un caso.
  "quality.desvios_alerted": false,
};

/**
 * Los eventos de la lista, más el reanálisis: se escribe con un literal y no
 * está en `AuditEvent`, pero una persona lo pide y devuelve el caso al agente.
 */
export const EVENTOS_DE_INTERVENCION: readonly string[] = [
  ...Object.entries(ES_INTERVENCION)
    .filter(([, interviene]) => interviene)
    .map(([evento]) => evento),
  "case.re_analyze_triggered",
];
