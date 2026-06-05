/**
 * UI strings — English (en-US).
 *
 * Mirror of es-AR.ts. All keys must match exactly.
 * Use the typed `t()` helper from src/lib/i18n/index.ts for type-safe access.
 */

import type { TranslationKey } from "./es-AR";

export const enUS: Record<TranslationKey, string> = {
  // ── App ────────────────────────────────────────────────────────────────────
  "app.name": "ClaimMix",
  "app.tagline": "Intelligent FNOL claims management",

  // ── Navigation ─────────────────────────────────────────────────────────────
  "nav.bandeja": "Inbox",
  "nav.escalados": "Escalated",
  "nav.clientes": "Clients",
  "nav.analisis": "Analysis",
  "nav.metricas": "Metrics",
  "nav.admin": "Administration",
  "nav.configuracion": "Settings",
  "nav.signOut": "Sign out",

  // ── Auth ───────────────────────────────────────────────────────────────────
  "auth.signIn.title": "Sign in",
  "auth.signIn.email": "Email address",
  "auth.signIn.password": "Password",
  "auth.signIn.submit": "Sign in",
  "auth.signIn.submitting": "Signing in...",
  "auth.signIn.error.invalid": "Invalid credentials. Please try again.",
  "auth.signIn.error.rateLimited": "Too many attempts. Please wait before retrying.",
  "auth.signIn.error.generic": "Sign in error. Please try again.",

  // ── Status labels ──────────────────────────────────────────────────────────
  "status.procesando": "Processing",
  "status.listo": "Ready",
  "status.esperando": "Waiting",
  "status.escalado": "Escalated",
  "status.cerrado": "Closed",
  "status.recibido": "Received",
  "status.info_faltante": "Missing info",
  "status.confirmacion_pendiente": "Pending confirmation",
  "status.requiere_especialista": "Requires specialist",
  "status.listo_para_core": "Ready for Core",
  "status.enviado_a_core": "Sent to Core",
  "status.error_core": "Core error",
  "status.no_relevante": "Not relevant",

  // ── Claim type labels ──────────────────────────────────────────────────────
  "type.todos": "All",
  "type.choque": "Collision",
  "type.robo": "Theft",
  "type.granizo": "Hail",
  "type.incendio": "Fire",
  "type.other": "Other",

  // ── Dashboard tabs ─────────────────────────────────────────────────────────
  "tabs.todos": "All",
  "tabs.listo": "Ready",
  "tabs.esperando": "Waiting",
  "tabs.escalado": "Escalated",
  "tabs.procesando": "Processing",
  "tabs.cerrado": "Closed",

  // ── Case table columns ─────────────────────────────────────────────────────
  "table.col.id": "ID",
  "table.col.policyholder": "Policyholder",
  "table.col.policy": "Policy",
  "table.col.type": "Type",
  "table.col.status": "Status",
  "table.col.confidence": "Score",
  "table.col.age": "Age",
  "table.col.assignedTo": "Assigned to",

  // ── Bandeja actions ────────────────────────────────────────────────────────
  "bandeja.simulate": "Simulate new email",
  "bandeja.export": "Export CSV",
  "bandeja.search": "Search cases...",
  "bandeja.empty": "No cases in this category.",
  "bandeja.loading": "Loading cases...",
  "bandeja.delete": "Delete case",
  "bandeja.deleteConfirm": "Confirm",
  "bandeja.deleteCancel": "Cancel",
  "bandeja.deleteSuccess": "Case deleted successfully.",

  // ── Simulate modal ─────────────────────────────────────────────────────────
  "simulate.title": "Simulate new claim",
  "simulate.scenario": "Claim type",
  "simulate.scenario.choque": "Collision",
  "simulate.scenario.robo": "Theft",
  "simulate.scenario.granizo": "Hail",
  "simulate.scenario.incendio": "Fire",
  "simulate.scenario.random": "Random",
  "simulate.submit": "Simulate",
  "simulate.submitting": "Simulating...",
  "simulate.success": "Case created successfully. Processing...",
  "simulate.error": "Error simulating the claim. Please try again.",

  // ── Case detail ────────────────────────────────────────────────────────────
  "case.detail.title": "Case detail",
  "case.detail.back": "Back to inbox",
  "case.detail.extractedFields": "Extracted fields",
  "case.detail.missingDocs": "Missing documentation",
  "case.detail.rawEmail": "Original text",
  "case.detail.auditLog": "History",
  "case.detail.confidence": "Confidence",
  "case.detail.close": "Close claim",
  "case.detail.escalate": "Escalate",
  "case.detail.reAnalyze": "Re-analyze",
  "case.detail.reAnalyzeStarted": "Re-analysis started. The page will update shortly.",
  "case.detail.reAnalyzeRateLimit": "Too many re-analyses. Please wait an hour before trying again.",
  "case.detail.exportToCore": "Export to Core",
  "case.detail.markComplete": "Mark complete",
  "case.detail.resolveEscalated": "Resolve escalated → Ready",
  "case.detail.processing": "Processing...",
  "case.detail.closedBanner": "Claim closed",
  "case.detail.insuredData": "Insured data",
  "case.detail.policyholderName": "Name",
  "case.detail.policyNumber": "Policy",
  "case.detail.email": "Email",
  "case.detail.channel": "Intake channel",
  "case.detail.assignedTo": "Assigned analyst",
  "case.detail.noFields": "No extracted fields.",
  "case.detail.noMissingDocs": "No pending documentation.",
  "case.detail.noAuditEvents": "No events recorded.",
  "case.detail.rawEmailToggle": "View original text",
  "case.detail.copyClipboard": "Copy to clipboard",
  "case.detail.copied": "Copied!",
  "case.detail.field": "Field",
  "case.detail.value": "Value",
  "case.detail.confidence.col": "Confidence",

  // ── Field key labels (en-US) ───────────────────────────────────────────────
  "field.full_name": "Full name",
  "field.email": "Email address",
  "field.phone": "Phone",
  "field.dni": "National ID",
  "field.policy_number": "Policy number",
  "field.accident_date": "Accident date",
  "field.accident_location": "Accident location",
  "field.accident_description": "Accident description",
  "field.date": "Incident date",
  "field.location": "Incident location",
  "field.party_a_name": "Driver A — Name",
  "field.party_a_plate": "Driver A — Plate",
  "field.party_b_name": "Driver B — Name",
  "field.party_b_plate": "Driver B — Plate",
  "field.declared_damage": "Declared damage",
  "field.stolen_items": "Stolen items",
  "field.hail_date": "Hail date",
  "field.fire_origin": "Fire origin",
  "field.witnesses": "Witnesses",
  "field.insurance_policy": "Insurance policy",
  "field.driver_name": "Driver name",
  "field.driver_license": "Driver's license",

  // ── Doc status labels ──────────────────────────────────────────────────────
  "doc.status.pending": "Pending",
  "doc.status.received": "Received",
  "doc.status.excused": "Excused",

  // ── Close dialog ───────────────────────────────────────────────────────────
  "close.title": "Close claim",
  "close.description": "Confirm closing this claim? This action cannot be undone.",
  "close.typeToConfirm": "To confirm, type the case number:",
  "close.reason": "Closing reason",
  "close.reason.paid_out": "Paid out",
  "close.reason.rejected": "Rejected",
  "close.reason.duplicate": "Duplicate",
  "close.reason.cancelled": "Cancelled by insured",
  "close.confirm": "Confirm close",
  "close.cancel": "Cancel",
  "close.success": "Claim closed successfully.",
  "close.error": "Error closing the claim. Please try again.",
  "close.errorFsm": "Invalid state transition.",

  // ── Escalate dialog ────────────────────────────────────────────────────────
  "escalate.title": "Escalate claim",
  "escalate.description": "Escalate this claim for manual review?",
  "escalate.reason": "Escalation reason",
  "escalate.reasonPlaceholder": "Describe the escalation reason (optional, max 500 characters)",
  "escalate.confirm": "Escalate",
  "escalate.cancel": "Cancel",
  "escalate.success": "Claim escalated successfully.",
  "escalate.error": "Error escalating the claim. Please try again.",

  // ── Missing docs ───────────────────────────────────────────────────────────
  "docs.parte_amistoso": "Friendly accident report",
  "docs.fotos_danos": "Damage photos",
  "docs.licencia_conducir": "Driver's license",
  "docs.denuncia_policial": "Police report",
  "docs.fotos_lugar": "Scene photos",
  "docs.foto_oblea_vtv": "VTV sticker photo",
  "docs.informe_bomberos": "Fire department report",

  // ── Confidence thresholds (UI labels) ─────────────────────────────────────
  "confidence.high": "High",
  "confidence.medium": "Medium",
  "confidence.low": "Low",

  // ── Audit log event types ──────────────────────────────────────────────────
  "audit.auth.success": "Successful sign in",
  "audit.auth.rate_limited": "Access attempts blocked (rate limit)",
  "audit.case.created": "Case created",
  "audit.case.closed": "Case closed",
  "audit.case.status_changed": "Status updated",
  "audit.ai.extracted": "AI extraction completed",
  "audit.ai.escalated": "Case escalated due to low confidence",

  // ── Supplemental pages ─────────────────────────────────────────────────────
  "analisis.title": "Analysis",
  "analisis.subtitle": "Aggregated claim statistics",
  "metricas.title": "Metrics",
  "metricas.subtitle": "System KPIs",
  "admin.users.title": "Analyst management",
  "admin.users.invite": "Invite analyst",
  "configuracion.title": "Settings",
  "configuracion.subtitle": "Environment variables (read-only)",

  // ── Health ─────────────────────────────────────────────────────────────────
  "health.ok": "ok",

  // ── Errors (generic) ──────────────────────────────────────────────────────
  "error.generic": "An unexpected error occurred. Please try again.",
  "error.notFound": "The requested resource does not exist.",
  "error.unauthorized": "Unauthorized access.",
  "error.forbidden": "You do not have permission to perform this action.",
  "error.validation": "The submitted data is not valid.",
  "error.rateLimited": "Too many requests. Please wait a moment.",
  "error.serverError": "Internal server error.",
  "error.notImplemented": "This feature is not available in this version.",

  // ── Pagination ─────────────────────────────────────────────────────────────
  "pagination.previous": "Previous",
  "pagination.next": "Next",
  "pagination.of": "of",
  "pagination.results": "results",

  // ── Severity labels ─────────────────────────────────────────────────────────
  "severity.low": "Low",
  "severity.medium": "Medium",
  "severity.high": "High",
  "severity.critical": "Critical",

  // ── Channel labels ──────────────────────────────────────────────────────────
  "channel.todos": "All",
  "channel.email": "Email",
  "channel.email_sim": "Simulation",

  // ── Bandeja filter labels ───────────────────────────────────────────────────
  "filter.channel": "Channel",
  "filter.severity": "Severity",
  "filter.isClaim": "Type",
  "filter.todos": "All",
  "filter.reclamos": "Claims",
  "filter.no_relevantes": "Not relevant",

  // ── Case detail email sections ──────────────────────────────────────────────
  "case.detail.parsedEmail": "Email data",
  "case.detail.fieldConfirmations": "Pending confirmations",
  "case.detail.attachments": "Attachments",
  "case.detail.coreSyncAction": "Send to core system",
  "case.detail.isClaim": "Is claim?",
  "case.detail.severity": "Severity",
  "case.detail.noConfirmations": "No pending confirmations.",
  "case.detail.noAttachments": "No attachments.",
  "case.detail.confirmField": "Confirm",
  "case.detail.rejectField": "Reject",
  "case.detail.fieldKey": "Field",
  "case.detail.proposedValue": "Proposed value",
  "case.detail.conflictValue": "Conflicting value",
  "case.detail.status": "Status",
  "case.detail.sendToCore": "Send to core system",
  "case.detail.sendingToCore": "Sending...",
  "case.detail.coreSyncSuccess": "Case sent to core system.",
  "case.detail.coreSyncError": "Error sending to core system.",
  "case.detail.confirmed": "Confirmed",
  "case.detail.rejected": "Rejected",
  "case.detail.corrected": "Corrected",
  "case.detail.pending": "Pending",
  "case.detail.attachmentCount": "attachment(s)",
  "case.detail.openAttachment": "Open",
  "case.detail.customer": "Client",
  "case.detail.policy": "Linked policy",

  // ── Gmail status panel ─────────────────────────────────────────────────────
  "gmail.status.title": "Gmail inbox",
  "gmail.status.label": "Status",
  "gmail.status.connected": "Connected",
  "gmail.status.error": "Error",
  "gmail.status.not_configured": "Not configured",
  "gmail.status.last_sync": "Last sync",
  "gmail.status.account": "Account",

  // ── Case table "Source" column ─────────────────────────────────────────────
  "table.col.source": "Source",

  // ── Provider badge labels ───────────────────────────────────────────────────
  "provider.gmail": "Gmail",
  "provider.sim": "Sim",

  // ── Messages thread ────────────────────────────────────────────────────────
  "messages.thread.title": "Received messages",
  "messages.thread.from": "From",
  "messages.thread.subject": "Subject",
  "messages.thread.received_at": "Received",
  "messages.thread.attachments": "attachment(s)",
  "messages.thread.no_subject": "(no subject)",
  "messages.thread.expand": "Show more",
  "messages.thread.collapse": "Show less",

  // ── Customers page ──────────────────────────────────────────────────────────
  "clientes.title": "Clients",
  "clientes.subtitle": "Tenant clients and policies",
  "clientes.search": "Search by name, ID or email...",
  "clientes.empty": "No clients found.",
  "clientes.col.name": "Name",
  "clientes.col.dni": "ID number",
  "clientes.col.email": "Email",
  "clientes.col.phone": "Phone",
  "clientes.col.policies": "Policies",
  "clientes.col.cases": "Cases",
  "clientes.col.createdAt": "Registered",
  "clientes.back": "Back to clients",
  "clientes.detail.personalInfo": "Personal info",
  "clientes.detail.policies": "Policies",
  "clientes.detail.cases": "Cases",
  "clientes.detail.noPolicies": "No policies on record.",
  "clientes.detail.noCases": "No cases on record.",
  "clientes.detail.policyNumber": "Policy number",
  "clientes.detail.policyType": "Type",
  "clientes.detail.policyStatus": "Status",
  "clientes.detail.validFrom": "Valid from",
  "clientes.detail.validTo": "Valid to",
} as const;
