/**
 * UI strings — Spanish (es-AR).
 *
 * All user-facing text in ClaimMix lives here.
 * No i18n framework is used (single locale per IC7 in answers.md).
 *
 * Convention: keys use dot-notation by namespace (nav, tabs, status, etc.).
 * Use the typed `t()` helper from src/lib/i18n/index.ts for type-safe access.
 */

export const esAR = {
  // ── App ────────────────────────────────────────────────────────────────────
  "app.name": "ClaimMix",
  "app.tagline": "Gestión inteligente de siniestros FNOL",

  // ── Navigation ─────────────────────────────────────────────────────────────
  "nav.bandeja": "Bandeja",
  "nav.escalados": "Escalados",
  "nav.clientes": "Clientes",
  "nav.analisis": "Análisis",
  "nav.metricas": "Métricas",
  "nav.admin": "Administración",
  "nav.configuracion": "Configuración",
  "nav.signOut": "Cerrar sesión",

  // ── Auth ───────────────────────────────────────────────────────────────────
  "auth.signIn.title": "Iniciar sesión",
  "auth.signIn.email": "Correo electrónico",
  "auth.signIn.password": "Contraseña",
  "auth.signIn.submit": "Ingresar",
  "auth.signIn.submitting": "Ingresando...",
  "auth.signIn.error.invalid": "Credenciales inválidas. Intentá de nuevo.",
  "auth.signIn.error.rateLimited":
    "Demasiados intentos. Esperá un momento antes de reintentar.",
  "auth.signIn.error.generic": "Error al iniciar sesión. Intentá de nuevo.",

  // ── Status labels ──────────────────────────────────────────────────────────
  "status.procesando": "Procesando",
  "status.listo": "Listo",
  "status.esperando": "Esperando",
  "status.escalado": "Escalado",
  "status.cerrado": "Cerrado",
  // Email-intake statuses (new in email-claims-intake workflow)
  "status.recibido": "Recibido",
  "status.info_faltante": "Info faltante",
  "status.confirmacion_pendiente": "Confirmación pendiente",
  "status.requiere_especialista": "Requiere especialista",
  "status.listo_para_core": "Listo para Core",
  "status.enviado_a_core": "Enviado a Core",
  "status.error_core": "Error Core",
  "status.no_relevante": "No relevante",

  // ── Claim type labels ──────────────────────────────────────────────────────
  "type.todos": "Todos",
  "type.choque": "Choque",
  "type.robo": "Robo",
  "type.granizo": "Granizo",
  "type.incendio": "Incendio",
  "type.other": "Otro",

  // ── Dashboard tabs ─────────────────────────────────────────────────────────
  "tabs.todos": "Todos",
  "tabs.listo": "Listos",
  "tabs.esperando": "Esperando",
  "tabs.escalado": "Escalados",
  "tabs.procesando": "Procesando",
  "tabs.cerrado": "Cerrados",

  // ── Case table columns ─────────────────────────────────────────────────────
  "table.col.id": "ID",
  "table.col.policyholder": "Asegurado",
  "table.col.policy": "Póliza",
  "table.col.type": "Tipo",
  "table.col.status": "Estado",
  "table.col.confidence": "Score",
  "table.col.age": "Antigüedad",
  "table.col.assignedTo": "Asignación",

  // ── Bandeja actions ────────────────────────────────────────────────────────
  "bandeja.simulate": "Simular nuevo email",
  "bandeja.export": "Exportar CSV",
  "bandeja.search": "Buscar casos...",
  "bandeja.empty": "No hay casos en esta categoría.",
  "bandeja.loading": "Cargando casos...",

  // ── Simulate modal ─────────────────────────────────────────────────────────
  "simulate.title": "Simular nuevo siniestro",
  "simulate.scenario": "Tipo de siniestro",
  "simulate.scenario.choque": "Choque",
  "simulate.scenario.robo": "Robo",
  "simulate.scenario.granizo": "Granizo",
  "simulate.scenario.incendio": "Incendio",
  "simulate.scenario.random": "Aleatorio",
  "simulate.submit": "Simular",
  "simulate.submitting": "Simulando...",
  "simulate.success": "Caso creado correctamente. Procesando...",
  "simulate.error": "Error al simular el siniestro. Intentá de nuevo.",

  // ── Case detail ────────────────────────────────────────────────────────────
  "case.detail.title": "Detalle del caso",
  "case.detail.back": "Volver a la bandeja",
  "case.detail.extractedFields": "Campos extraídos",
  "case.detail.missingDocs": "Documentación faltante",
  "case.detail.rawEmail": "Texto original",
  "case.detail.auditLog": "Historial",
  "case.detail.confidence": "Confianza",
  "case.detail.close": "Cerrar siniestro",
  "case.detail.escalate": "Escalar",
  "case.detail.reAnalyze": "Re-analizar",
  "case.detail.exportToCore": "Exportar al Core",
  "case.detail.markComplete": "Marcar completo",
  "case.detail.resolveEscalated": "Resolver escalado → Listo",
  "case.detail.processing": "Procesando...",
  "case.detail.closedBanner": "Siniestro cerrado",
  "case.detail.insuredData": "Datos del asegurado",
  "case.detail.policyholderName": "Nombre",
  "case.detail.policyNumber": "Póliza",
  "case.detail.email": "Email",
  "case.detail.channel": "Canal de ingreso",
  "case.detail.assignedTo": "Analista asignado",
  "case.detail.noFields": "Sin campos extraídos.",
  "case.detail.noMissingDocs": "Sin documentación pendiente.",
  "case.detail.noAuditEvents": "Sin eventos registrados.",
  "case.detail.rawEmailToggle": "Ver texto original",
  "case.detail.copyClipboard": "Copiar al portapapeles",
  "case.detail.copied": "¡Copiado!",
  "case.detail.field": "Campo",
  "case.detail.value": "Valor",
  "case.detail.confidence.col": "Confianza",

  // ── Field key labels (es-AR) ───────────────────────────────────────────────
  "field.full_name": "Nombre completo",
  "field.email": "Correo electrónico",
  "field.phone": "Teléfono",
  "field.dni": "DNI",
  "field.policy_number": "Número de póliza",
  "field.accident_date": "Fecha del siniestro",
  "field.accident_location": "Lugar del siniestro",
  "field.accident_description": "Descripción del siniestro",
  "field.date": "Fecha del siniestro",
  "field.location": "Lugar del siniestro",
  "field.party_a_name": "Conductor A — Nombre",
  "field.party_a_plate": "Conductor A — Patente",
  "field.party_b_name": "Conductor B — Nombre",
  "field.party_b_plate": "Conductor B — Patente",
  "field.declared_damage": "Daños declarados",
  "field.stolen_items": "Bienes sustraídos",
  "field.hail_date": "Fecha de granizo",
  "field.fire_origin": "Origen del incendio",
  "field.witnesses": "Testigos",
  "field.insurance_policy": "Póliza de seguro",
  "field.driver_name": "Nombre del conductor",
  "field.driver_license": "Licencia de conducir",

  // ── Doc status labels ──────────────────────────────────────────────────────
  "doc.status.pending": "Pendiente",
  "doc.status.received": "Recibido",
  "doc.status.excused": "Excusado",

  // ── Close dialog ───────────────────────────────────────────────────────────
  "close.title": "Cerrar siniestro",
  "close.description": "¿Confirmar cierre del siniestro? Esta acción no puede deshacerse.",
  "close.typeToConfirm": "Para confirmar, escribí el número de caso:",
  "close.reason": "Motivo de cierre",
  "close.reason.paid_out": "Liquidado",
  "close.reason.rejected": "Rechazado",
  "close.reason.duplicate": "Duplicado",
  "close.reason.cancelled": "Cancelado por el asegurado",
  "close.confirm": "Confirmar cierre",
  "close.cancel": "Cancelar",
  "close.success": "Siniestro cerrado correctamente.",
  "close.error": "Error al cerrar el siniestro. Intentá de nuevo.",
  "close.errorFsm": "Transición de estado no válida.",

  // ── Escalate dialog ────────────────────────────────────────────────────────
  "escalate.title": "Escalar siniestro",
  "escalate.description": "¿Escalar este siniestro para revisión manual?",
  "escalate.reason": "Motivo del escalado",
  "escalate.reasonPlaceholder": "Describí el motivo del escalado (opcional, máx. 500 caracteres)",
  "escalate.confirm": "Escalar",
  "escalate.cancel": "Cancelar",
  "escalate.success": "Siniestro escalado correctamente.",
  "escalate.error": "Error al escalar el siniestro. Intentá de nuevo.",

  // ── Missing docs ───────────────────────────────────────────────────────────
  "docs.parte_amistoso": "Parte amistoso de accidente",
  "docs.fotos_danos": "Fotos de los daños",
  "docs.licencia_conducir": "Licencia de conducir",
  "docs.denuncia_policial": "Denuncia policial",
  "docs.fotos_lugar": "Fotos del lugar del hecho",
  "docs.foto_oblea_vtv": "Foto de la oblea VTV",
  "docs.informe_bomberos": "Informe de bomberos",

  // ── Confidence thresholds (UI labels) ─────────────────────────────────────
  "confidence.high": "Alta",
  "confidence.medium": "Media",
  "confidence.low": "Baja",

  // ── Audit log event types ──────────────────────────────────────────────────
  "audit.auth.success": "Inicio de sesión exitoso",
  "audit.auth.rate_limited": "Intentos de acceso bloqueados (rate limit)",
  "audit.case.created": "Caso creado",
  "audit.case.closed": "Caso cerrado",
  "audit.case.status_changed": "Estado actualizado",
  "audit.ai.extracted": "Extracción AI completada",
  "audit.ai.escalated": "Caso escalado por baja confianza",

  // ── Supplemental pages ─────────────────────────────────────────────────────
  "analisis.title": "Análisis",
  "analisis.subtitle": "Estadísticas agregadas de siniestros",
  "metricas.title": "Métricas",
  "metricas.subtitle": "KPIs del sistema",
  "admin.users.title": "Gestión de analistas",
  "admin.users.invite": "Invitar analista",
  "configuracion.title": "Configuración",
  "configuracion.subtitle": "Variables de entorno (sólo lectura)",

  // ── Health ─────────────────────────────────────────────────────────────────
  "health.ok": "ok",

  // ── Errors (generic) ──────────────────────────────────────────────────────
  "error.generic": "Ocurrió un error inesperado. Intentá de nuevo.",
  "error.notFound": "El recurso solicitado no existe.",
  "error.unauthorized": "Acceso no autorizado.",
  "error.forbidden": "No tenés permisos para realizar esta acción.",
  "error.validation": "Los datos enviados no son válidos.",
  "error.rateLimited": "Demasiadas solicitudes. Esperá un momento.",
  "error.serverError": "Error interno del servidor.",
  "error.notImplemented": "Esta función no está disponible en esta versión.",

  // ── Pagination ─────────────────────────────────────────────────────────────
  "pagination.previous": "Anterior",
  "pagination.next": "Siguiente",
  "pagination.of": "de",
  "pagination.results": "resultados",

  // ── Severity labels ─────────────────────────────────────────────────────────
  "severity.low": "Bajo",
  "severity.medium": "Medio",
  "severity.high": "Alto",
  "severity.critical": "Crítico",

  // ── Channel labels ──────────────────────────────────────────────────────────
  "channel.todos": "Todos",
  "channel.email": "Email",
  "channel.email_sim": "Simulación",

  // ── Bandeja filter labels ───────────────────────────────────────────────────
  "filter.channel": "Canal",
  "filter.severity": "Severidad",
  "filter.isClaim": "Tipo",
  "filter.todos": "Todos",
  "filter.reclamos": "Reclamos",
  "filter.no_relevantes": "No relevantes",

  // ── Case detail email sections ──────────────────────────────────────────────
  "case.detail.parsedEmail": "Datos del email",
  "case.detail.fieldConfirmations": "Confirmaciones pendientes",
  "case.detail.attachments": "Adjuntos",
  "case.detail.coreSyncAction": "Enviar al sistema central",
  "case.detail.isClaim": "¿Es reclamo?",
  "case.detail.severity": "Severidad",
  "case.detail.noConfirmations": "Sin confirmaciones pendientes.",
  "case.detail.noAttachments": "Sin adjuntos.",
  "case.detail.confirmField": "Confirmar",
  "case.detail.rejectField": "Rechazar",
  "case.detail.fieldKey": "Campo",
  "case.detail.proposedValue": "Valor propuesto",
  "case.detail.conflictValue": "Valor en conflicto",
  "case.detail.status": "Estado",
  "case.detail.sendToCore": "Enviar al sistema central",
  "case.detail.sendingToCore": "Enviando...",
  "case.detail.coreSyncSuccess": "Caso enviado al sistema central.",
  "case.detail.coreSyncError": "Error al enviar al sistema central.",
  "case.detail.confirmed": "Confirmado",
  "case.detail.rejected": "Rechazado",
  "case.detail.corrected": "Corregido",
  "case.detail.pending": "Pendiente",
  "case.detail.attachmentCount": "adjunto(s)",
  "case.detail.openAttachment": "Abrir",
  "case.detail.customer": "Cliente",
  "case.detail.policy": "Póliza vinculada",

  // ── Gmail status panel (W1) ─────────────────────────────────────────────────
  "gmail.status.title": "Bandeja de entrada Gmail",
  "gmail.status.label": "Estado",
  "gmail.status.connected": "Conectado",
  "gmail.status.error": "Error",
  "gmail.status.not_configured": "Sin configurar",
  "gmail.status.last_sync": "Último sync",
  "gmail.status.account": "Cuenta",

  // ── Case table "Fuente" column (W3) ─────────────────────────────────────────
  "table.col.source": "Fuente",

  // ── Provider badge labels (W3) ───────────────────────────────────────────────
  "provider.gmail": "Gmail",
  "provider.sim": "Sim",

  // ── Messages thread (W2) ────────────────────────────────────────────────────
  "messages.thread.title": "Mensajes recibidos",
  "messages.thread.from": "De",
  "messages.thread.subject": "Asunto",
  "messages.thread.received_at": "Recibido",
  "messages.thread.attachments": "adjunto(s)",
  "messages.thread.no_subject": "(sin asunto)",
  "messages.thread.expand": "Ver más",
  "messages.thread.collapse": "Ver menos",

  // ── Customers page ──────────────────────────────────────────────────────────
  "clientes.title": "Clientes",
  "clientes.subtitle": "Clientes y pólizas del tenant",
  "clientes.search": "Buscar por nombre, DNI o email...",
  "clientes.empty": "No se encontraron clientes.",
  "clientes.col.name": "Nombre",
  "clientes.col.dni": "DNI",
  "clientes.col.email": "Email",
  "clientes.col.phone": "Teléfono",
  "clientes.col.policies": "Pólizas",
  "clientes.col.cases": "Casos",
  "clientes.col.createdAt": "Alta",
  "clientes.back": "Volver a clientes",
  "clientes.detail.personalInfo": "Datos personales",
  "clientes.detail.policies": "Pólizas",
  "clientes.detail.cases": "Casos",
  "clientes.detail.noPolicies": "Sin pólizas registradas.",
  "clientes.detail.noCases": "Sin casos registrados.",
  "clientes.detail.policyNumber": "Número de póliza",
  "clientes.detail.policyType": "Tipo",
  "clientes.detail.policyStatus": "Estado",
  "clientes.detail.validFrom": "Vigencia desde",
  "clientes.detail.validTo": "Vigencia hasta",
} as const;

export type TranslationKey = keyof typeof esAR;
