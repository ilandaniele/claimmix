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

  // ── Claim type labels ──────────────────────────────────────────────────────
  "type.todos": "Todos",
  "type.choque": "Choque",
  "type.robo": "Robo",
  "type.granizo": "Granizo",
  "type.incendio": "Incendio",

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
  "case.detail.extractedFields": "Campos extraídos",
  "case.detail.missingDocs": "Documentación faltante",
  "case.detail.rawEmail": "Email original",
  "case.detail.auditLog": "Historial de auditoría",
  "case.detail.confidence": "Confianza",
  "case.detail.close": "Cerrar caso",
  "case.detail.reAnalyze": "Re-analizar",
  "case.detail.exportToCore": "Exportar al core",

  // ── Close dialog ───────────────────────────────────────────────────────────
  "close.title": "Cerrar caso",
  "close.reason": "Motivo de cierre",
  "close.reason.paid_out": "Liquidado",
  "close.reason.rejected": "Rechazado",
  "close.reason.duplicate": "Duplicado",
  "close.reason.cancelled": "Cancelado por el asegurado",
  "close.confirm": "Confirmar cierre",
  "close.cancel": "Cancelar",
  "close.success": "Caso cerrado correctamente.",
  "close.error": "Error al cerrar el caso. Intentá de nuevo.",

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
} as const;

export type TranslationKey = keyof typeof esAR;
