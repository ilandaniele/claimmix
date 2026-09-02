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
  "nav.operation": "Operación",
  "nav.demo": "Demo",
  "nav.principal": "Navegación principal",
  "nav.agente": "Agente",
  "nav.agenteBloqueado": "Solo administradores pueden abrir la consola del agente.",
  "nav.facturacion": "Facturación",
  "nav.cartera": "Cartera",

  /*
   * La antigüedad de un siniestro. El `{n}` es el número, y es el único lugar
   * del diccionario que lo usa: acá no alcanza con componer claves sueltas,
   * porque en inglés el número va adelante («3d ago») y en castellano atrás
   * («Hace 3d»). Es el orden de las palabras lo que cambia, no las palabras.
   */
  "age.now": "Ahora",
  "age.minutes": "Hace {n}m",
  "age.hours": "Hace {n}h",
  "age.days": "Hace {n}d",
  "role.admin": "Administrador",
  "role.analyst": "Analista",
  "theme.toggle": "Cambiar tema",
  "theme.light": "Modo claro",
  "theme.dark": "Modo oscuro",
  "common.yes": "Sí",
  "common.no": "No",

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
  "type.cristales": "Cristales",
  "type.rc": "Resp. Civil",
  "type.robo_contenido": "Robo de contenido",
  "type.accidente_personal": "Accidente personal",
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
  "table.col.replied": "Respondido",
  "table.replied.yes": "Respondido",
  "table.replied.pending": "Sin responder",
  "table.col.confidence": "Score",
  "table.col.age": "Antigüedad",
  "table.col.received": "Recibido",
  "table.col.assignedTo": "Asignación",

  // ── Bandeja actions ────────────────────────────────────────────────────────
  "bandeja.simulate": "Simular nuevo email",
  "bandeja.export": "Exportar CSV",
  "bandeja.search": "Buscar casos...",
  "bandeja.empty": "No hay siniestros que coincidan con los filtros.",
  "bandeja.loading": "Cargando casos...",
  "bandeja.delete": "Eliminar caso",
  "bandeja.deleteSelected": "Eliminar seleccionados",
  "bandeja.deleteConfirm": "Eliminar",
  "bandeja.deleteCancel": "Cancelar",
  "bandeja.deleteSuccess": "Caso eliminado correctamente.",
  "bandeja.deleteError": "No se pudo eliminar el caso. Recargá e intentá de nuevo.",
  "bandeja.deleteConfirmTitle": "¿Eliminás este siniestro?",
  "bandeja.deleteConfirmBody1": "Esta acción no se puede deshacer.",
  "bandeja.deleteConfirmBodyN": "Estás por eliminar",
  "bandeja.deleteConfirmIrreversible": "Esta acción no se puede deshacer.",
  "bandeja.deleteRemember": "No volver a preguntar",
  "bandeja.title": "Bandeja de siniestros",
  "bandeja.subtitle": "Gestioná y filtrá los siniestros FNOL del sistema",
  "bandeja.showing": "Mostrando",
  "bandeja.claims": "siniestros",
  "bandeja.selected": "seleccionado(s)",
  "bandeja.deleteManySuccess": "siniestro(s) eliminados.",
  "bandeja.deleteManyPartial": "siniestro(s) no se pudieron eliminar.",
  "bandeja.selectAll": "Seleccionar todos",
  "bandeja.selectCase": "Seleccionar",
  "bandeja.tableLabel": "Tabla de siniestros",
  "bandeja.toastNew": "Nuevo siniestro recibido:",
  "bandeja.toastUpdated": "actualizado:",

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
  "case.detail.missingDocs": "Documentación y datos",
  "case.detail.docsGroup": "Documentación",
  "case.detail.fieldsGroup": "Datos por confirmar",
  "case.detail.rawEmail": "Texto original",
  "case.detail.auditLog": "Historial",
  "case.detail.confidence": "Confianza",
  "case.detail.close": "Cerrar siniestro",
  "case.detail.escalate": "Escalar",
  "case.detail.reAnalyze": "Re-analizar",
  "case.detail.reAnalyzeStarted": "Re-análisis iniciado. La página se actualizará en breve.",
  "case.detail.reAnalyzeRateLimit": "Demasiados re-análisis. Esperá una hora antes de volver a intentarlo.",
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
  "case.detail.assigned": "Asignado",
  "case.detail.unassigned": "Sin asignar",
  "case.detail.created": "Creado",
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
  "doc.status.declined": "No lo tienen",

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
  "audit.ai.extracted": "Extracción IA completada",
  "audit.ai.extraction_complete": "Extracción IA completada",
  "audit.ai.escalated": "Caso escalado por baja confianza",
  "audit.email.received": "Email recibido",
  "audit.intake.agent_decision": "Decisión del agente",
  "audit.attachment.rejected": "Adjunto rechazado",

  // ── Supplemental pages ─────────────────────────────────────────────────────
  "analisis.title": "Análisis",
  "analisis.subtitle": "Estadísticas agregadas de siniestros",
  "metricas.title": "Métricas",
  "metricas.subtitle": "KPIs del sistema",
  "admin.users.title": "Gestión de analistas",
  "admin.users.invite": "Invitar analista",
  "configuracion.title": "Configuración",
  "configuracion.subtitle": "Variables de entorno (sólo lectura)",
  "configuracion.agentTraining.title": "Entrenamiento del agente",
  "configuracion.agentTraining.label": "Instrucciones y ejemplos para el agente",
  "configuracion.agentTraining.enabled": "Activo en producción",
  "configuracion.agentTraining.helper": "Se inyecta en el prompt del agente de email para futuras extracciones. No re-procesa casos anteriores.",
  "configuracion.agentTraining.save": "Guardar entrenamiento",
  "configuracion.agentTraining.saving": "Guardando...",
  "configuracion.agentTraining.saved": "Entrenamiento guardado. El agente lo usará en producción en el próximo análisis.",
  "configuracion.agentTraining.loadError": "No se pudo cargar el entrenamiento del agente.",
  "configuracion.agentTraining.saveError": "No se pudo guardar el entrenamiento del agente.",
  "configuracion.agentTraining.placeholder": "Ejemplos de guía:\n- Para emails con \"Datos del asegurado\", extraer Nombre completo como full_name y Número de póliza como policy_number con alta confianza.\n- Si \"Documentación adjunta\" lista fotos, licencia o denuncia policial, marcar esos documentos como presentes.\n- Para un choque entre dos autos con patentes y sin heridos, la severidad suele ser medium.\n- Pedir confirmación solo cuando un valor sea ambiguo o entre en conflicto con datos guardados de cliente/póliza.",

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
  "pagination.perPage": "Por página",
  "pagination.page": "Página",
  "pagination.first": "Primera página",
  "pagination.last": "Última página",

  // ── Severity labels ─────────────────────────────────────────────────────────
  "severity.low": "Bajo",
  "severity.medium": "Medio",
  "severity.high": "Alto",
  "severity.critical": "Crítico",

  // ── Channel labels ──────────────────────────────────────────────────────────
  "channel.todos": "Todos",
  "channel.email": "Email",
  "channel.email_sim": "Simulación",
  "channel.whatsapp": "WhatsApp",
  "channel.whatsapp_sim": "WhatsApp simulado",

  // ── Bandeja filter labels ───────────────────────────────────────────────────
  "filter.channel": "Canal",
  "filter.severity": "Severidad",
  /*
   * Era «Tipo», la MISMA palabra que el filtro de tipo de siniestro que esta
   * justo arriba. Con los dos grupos en la misma franja quedaban dos «Tipo:»
   * pegados, uno ofreciendo Choque/Robo/Granizo y el otro Reclamos/No
   * relevantes. Este filtro no pregunta de que tipo es el siniestro sino si el
   * mensaje es un siniestro.
   */
  "filter.isClaim": "Relevancia",
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
  "case.detail.linked": "Vinculada",
  "case.detail.pendingCount": "pendiente(s)",
  "case.detail.coreReadyDescription": "Este caso está listo para ser enviado al sistema central. Revisá los campos confirmados antes de proceder.",
  "case.detail.noRawEmail": "Sin texto original disponible.",
  "case.detail.agentAnalysis": "Análisis del agente",
  "case.detail.auditReason": "Motivo",

  "gmail.accounts.title": "Cuentas Gmail de ingreso",
  "gmail.accounts.helper": "Conectá una o más casillas Gmail para crear siniestros automáticamente desde cada inbox.",
  "gmail.accounts.connect": "Conectar Gmail",
  "gmail.accounts.connectAnother": "Conectar otra cuenta",

  // ── AI provider switch ─────────────────────────────────────────────────────
  "aiProvider.title": "Modelo de IA",
  "aiProvider.helper":
    "Elegí qué proveedor de IA analiza los emails entrantes. El cambio aplica de inmediato a los próximos emails.",
  "aiProvider.openaiHelper": "GPT — requiere créditos de API en OpenAI.",
  "aiProvider.geminiHelper": "Gemini — capa gratuita de Google AI Studio.",
  "aiProvider.active": "Activo",
  "aiProvider.notConfigured": "No configurado",
  "aiProvider.configureKey": "Agregar API key",
  "aiProvider.geminiKeyLabel": "API key de Gemini",
  "aiProvider.geminiKeyPlaceholder": "AIza...",
  "aiProvider.saveKey": "Guardar key",
  "aiProvider.keySaved": "Key guardada. Ya podés activar Gemini.",
  "aiProvider.keySaveError": "No se pudo guardar la API key.",
  "aiProvider.loading": "Cargando configuración...",
  "aiProvider.loadError": "No se pudo cargar la configuración de IA.",
  "aiProvider.saveError": "No se pudo guardar el proveedor de IA.",
  "aiProvider.saved": "Proveedor actualizado. Los próximos emails se analizarán con este modelo.",
  "gmail.accounts.loading": "Cargando cuentas...",
  "gmail.accounts.empty": "Todavía no hay cuentas Gmail conectadas.",
  "gmail.accounts.enabled": "Activa",
  "gmail.accounts.remove": "Eliminar",
  "gmail.accounts.connected": "Conectada",
  "gmail.accounts.pending": "Pendiente",
  "gmail.accounts.error": "Con error",
  "gmail.accounts.loadError": "No se pudieron cargar las cuentas Gmail.",
  "gmail.accounts.saveError": "No se pudo actualizar la cuenta Gmail.",
  "gmail.accounts.deleteError": "No se pudo eliminar la cuenta Gmail.",

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
  "clientes.detail.viewClient": "Ver cliente",
  "clientes.detail.policyNumber": "Número de póliza",
  "clientes.detail.policyType": "Tipo",
  "clientes.detail.policyStatus": "Estado",
  "clientes.detail.validFrom": "Vigencia desde",
  "clientes.detail.validTo": "Vigencia hasta",
  /*
   * Lo que quedaba escrito a mano en las dos pantallas de clientes.
   *
   * Los encabezados sí pasaban por `t()`, así que con la interfaz en inglés
   * quedaba una mezcla: columnas «Name / ID number / Registered» y al lado
   * botones «Buscar» y «Limpiar», celdas «Automóvil» y «Activa», y al pie
   * «Mostrando 1–14 de 14 clientes». Hasta ahora no se notaba porque el padrón
   * de ensayo estaba vacío.
   */
  "clientes.doSearch": "Buscar",
  "clientes.clear": "Limpiar",
  "clientes.tableLabel": "Tabla de clientes",
  "clientes.plural": "clientes",
  "clientes.policyType.auto": "Automóvil",
  "clientes.policyType.home": "Hogar",
  "clientes.policyType.life": "Vida",
  "clientes.policyType.business": "Empresa",
  "clientes.policyType.other": "Otro",
  "clientes.policyStatus.active": "Activa",
  "clientes.policyStatus.expired": "Vencida",
  "clientes.policyStatus.cancelled": "Cancelada",
  // ── Las baldosas de indicador de la bandeja ─────────────────────────────────
  // Estaban escritas a mano en castellano dentro de `bandeja/page.tsx`, asi que
  // con la interfaz en ingles la fila de indicadores seguia en castellano.
  "kpi.total": "Total casos",
  "kpi.criticalHint": "Necesitan una persona",
  "kpi.criticalNone": "Ninguno abierto",
  "kpi.pendingHint": "Esperando al denunciante",

  /*
   * Las cinco pantallas que estaban enteras en castellano.
   *
   * No era el olvido de una palabra suelta: no tenian UNA sola llamada al
   * diccionario, asi que con la interfaz en ingles quedaban enteras en
   * castellano. Por eso tampoco se les traducian las fechas — una fecha en
   * formato ingles adentro de una oracion en castellano se lee como un error,
   * no como localizacion.
   */

  // ── La consola del agente, adentro del detalle de un caso ─────────
  "agente.avisoAprendizaje": "El agente nunca aprende de un email automáticamente: solo después de esta confirmación humana se usa como ejemplo aprobado.",
  "agente.bloqueo.invalid_json": "JSON inválido",
  "agente.bloqueo.no_linked_case": "Sin caso vinculado",
  "agente.bloqueo.not_a_claim": "No es un reclamo",
  "agente.bloqueo.prompt_injection_suspected": "Posible inyección de prompt",
  "agente.bloqueo.unresolved_conflicts": "Conflictos sin resolver",
  "agente.cargando": "Cargando análisis del agente",
  "agente.confirmando": "Confirmando…",
  "agente.confirmar": "Confirmar como ejemplo de entrenamiento seguro",
  "agente.confirmarError": "No se pudo confirmar el ejemplo.",
  "agente.confirmarOk": "Ejemplo confirmado. El agente lo usará como contexto aprobado en próximos análisis.",
  "agente.descargarJson": "Descargar JSON extraído",
  "agente.emailOriginal": "Email original analizado",
  "agente.errorCarga": "No se pudo cargar el análisis del agente. Recargá la página para reintentar.",
  "agente.faltantes": "Campos faltantes",
  "agente.jsonCrudo": "JSON extraído (crudo)",
  "agente.noSugerido": "No sugerido para entrenamiento",
  "agente.pendientes": "Pendientes de confirmación",
  "agente.procesando": "El agente está procesando este email… los valores extraídos aparecerán acá automáticamente.",
  "agente.puntaje": "Puntaje",
  "agente.sinAnalisis": "Todavía no hay un análisis del agente registrado para este caso. Usá «Re-analizar» para generarlo.",
  "agente.sinCuerpo": "(sin cuerpo)",
  "agente.sinFaltantes": "Sin campos faltantes.",
  "agente.sinPendientes": "Sin campos pendientes.",
  "agente.sinValores": "El agente no extrajo valores en el último análisis.",
  "agente.sugerido": "Sugerido para entrenamiento",
  "agente.valoresExtraidos": "Valores extraídos (último análisis)",
  "agente.yaConfirmado": "Ejemplo ya confirmado",


  // ── Los nombres comerciales de los planes ──────────────────────────
  // El precio y la aritmética siguen en `lib/billing/plans.ts`, que no conoce
  // el diccionario: acá está sólo cómo se escribe el nombre.
  "plan.piloto": "Piloto",
  "plan.operativo": "Operativo",
  "plan.profesional": "Profesional",
  "plan.corporativo": "Corporativo",
  "plan.enterprise": "Enterprise",

  // ── Cartera — la vista del operador de ClaimMix, cruza aseguradoras ───
  "cartera.aFacturar": "A facturar",
  "cartera.ayuda.alta": "Un cliente nuevo se da de alta con",
  "cartera.ayuda.aplica": ", que aplica los términos del plan e imprime lo que queda por configurar a mano. El alta entera se ensaya sobre un tenant descartable con",
  "cartera.col.cliente": "Cliente",
  "cartera.col.costoIa": "Costo IA",
  "cartera.col.denuncias": "Denuncias",
  "cartera.col.margen": "Margen",
  "cartera.col.plan": "Plan",
  "cartera.deMargen": "de margen",
  "cartera.empty": "Todavía no hay clientes.",
  "cartera.estado.active": "Activo",
  "cartera.estado.churned": "Se fue",
  "cartera.estado.suspended": "Suspendido",
  "cartera.estado.trial": "Prueba",
  "cartera.hasta": "hasta",
  "cartera.incluidas": "incl.",
  "cartera.mensajes": "mensajes",
  "cartera.sinIngresos": "sin ingresos todavía",
  "cartera.stat.clientes": "Clientes",
  "cartera.stat.costoIa": "Costo de IA",
  "cartera.stat.denuncias": "Denuncias facturables",
  "cartera.subtitle": "La cartera y sus números de",
  "cartera.subtitleOperator": "Sólo la ve quien opera ClaimMix.",
  "cartera.title": "Cartera",

  // ── Facturacion — la liquidacion del mes de una aseguradora ───────
  "facturacion.aFacturar": "A facturar",
  "facturacion.abonoPlan": "Abono {n}",
  "facturacion.bucket.facturables": "Facturables",
  "facturacion.bucket.mensajesEnTotal": "Mensajes en total",
  "facturacion.bucket.noEranDenuncias": "No eran denuncias",
  "facturacion.bucket.sinResolver": "Sin resolver",
  "facturacion.cambiarMes": "Cambiar de mes",
  "facturacion.cerradoAntesDeLaFecha": "Esta liquidación quedó guardada el",
  "facturacion.cerradoDespuesDeLaFecha": "y ya no cambia, aunque después se editen o se borren casos de ese mes.",
  "facturacion.costoDeIa": "Costo de IA",
  "facturacion.deDondeSale": "De dónde sale ese número",
  "facturacion.deDondeSaleDetalle": "Se factura la denuncia que el agente reconoció como denuncia. Lo que descartó por no serlo no se cobra: cobrar el spam filtrado convertiría al filtro en una fuente de ingresos.",
  "facturacion.denunciasIncluidas": "Denuncias incluidas",
  "facturacion.excedente": "Excedente",
  "facturacion.formatoPeriodo": "AAAA-MM",
  "facturacion.llamadasAlModelo": "Llamadas al modelo",
  "facturacion.loQueCosto": "Lo que costó atenderlo",
  "facturacion.margen": "Margen",
  "facturacion.mesAnterior": "Mes anterior",
  "facturacion.mesEnCurso": "Mes en curso.",
  "facturacion.mesEnCursoDetalle": "El número sube con cada denuncia que entra. Se cierra solo cuando termine el mes, y a partir de ahí no se mueve.",
  "facturacion.mesSiguiente": "Mes siguiente",
  "facturacion.periodoCerrado": "Período cerrado.",
  "facturacion.periodoEsperado": "Se espera",
  "facturacion.periodoInvalido": "no es un período válido.",
  "facturacion.plan": "plan {n}",
  "facturacion.porDenunciaFacturable": "Por denuncia facturable",
  "facturacion.sinIngresos": "sin ingresos este mes",
  "facturacion.total": "Total",
  "facturacion.verMesEnCurso": "Ver el mes en curso",

  // ── Metricas — el tablero del mes ─────────────────────────────────
  "metricas.card.completitudAuto": "Tasa de completitud automática",
  "metricas.card.escalados": "Siniestros escalados",
  "metricas.card.tiempoApertura": "Tiempo medio de apertura",
  "metricas.card.totalMes": "Total siniestros (mes)",
  "metricas.col.casosCerrados": "Casos cerrados",
  "metricas.col.costo": "Costo",
  "metricas.col.modelo": "Modelo",
  "metricas.col.tokens": "Tokens",
  "metricas.col.usuario": "Usuario",
  "metricas.emptyPeriod": "No hay datos disponibles para el período seleccionado.",
  "metricas.ia.costoMes": "Costo este mes",
  "metricas.ia.costoTotal": "Costo histórico",
  "metricas.ia.ejecAbrev": "ejec.",
  "metricas.ia.ejecuciones": "ejecuciones",
  "metricas.ia.porModelo": "Tokens por modelo este mes",
  "metricas.ia.porUsuario": "Tokens por usuario este mes",
  "metricas.ia.prompt": "prompt",
  "metricas.ia.respuesta": "respuesta",
  "metricas.ia.subtitulo": "Tokens consumidos y costo estimado del tenant.",
  "metricas.ia.titulo": "Uso de IA",
  "metricas.ia.tokensMes": "Tokens este mes",
  "metricas.ia.tokensTotal": "Tokens históricos",
  "metricas.ia.vacio": "Sin consumo de IA este mes.",
  "metricas.porEstado": "Siniestros por estado",
  "metricas.porTipo": "Siniestros por tipo",
  "metricas.sinCasosCerrados": "Ningún caso cerrado este mes.",
  "metricas.sinDatos": "Sin datos.",
  "metricas.topAnalistas": "Top 5 analistas — casos cerrados este mes",

  // ── Alta y roles de los usuarios de una aseguradora ───────────────
  "usuarios.activo": "Activo",
  "usuarios.bloqueado": "Bloqueado",
  "usuarios.cambiarRol": "Cambiar rol de",
  "usuarios.cancelar": "Cancelar",
  "usuarios.cargando": "Cargando...",
  "usuarios.col.creado": "Creado",
  "usuarios.col.email": "Email",
  "usuarios.col.estado": "Estado",
  "usuarios.col.nombre": "Nombre",
  "usuarios.col.rol": "Rol",
  "usuarios.enviandoInvitacion": "Invitando...",
  "usuarios.enviarInvitacion": "Invitar",
  "usuarios.error.crear": "Error al crear el usuario. Intentá de nuevo.",
  "usuarios.error.red": "Error de red. Intentá de nuevo.",
  "usuarios.error.rol": "No se pudo actualizar el rol.",
  "usuarios.form.email": "Correo electrónico",
  "usuarios.form.emailPlaceholder": "analista@empresa.com",
  "usuarios.form.nombre": "Nombre completo",
  "usuarios.form.nombrePlaceholder": "Ej: María García",
  "usuarios.form.rol": "Rol",
  "usuarios.invitar": "Invitar usuario",
  "usuarios.propio": "Tu usuario",
  "usuarios.title": "Gestión de usuarios",
  "usuarios.subtitle": "Invitá usuarios y asigná roles operativos o administradores.",
  "usuarios.rol.admin": "Admin",
  "usuarios.rol.analyst": "Analista",
  "usuarios.rol.owner": "Owner",
  "usuarios.rol.specialist": "Especialista",
  "usuarios.rol.viewer": "Visor",
  "usuarios.rol.viewerSoloLectura": "Visor (solo lectura)",
  "usuarios.toast.creado": "Usuario creado. Se enviará un correo de invitación.",
  "usuarios.toast.rolActualizado": "Rol actualizado.",
  "usuarios.vacio": "No hay usuarios registrados.",


  // ── La consola del agente — /agente, la pantalla entera ───────────
  // Distinto de `agente.*`, que es el panel de análisis adentro de un caso.
  // Acá se configura el agente; allá se lee lo que el agente extrajo.
  "consola.tab.campos": "Campos personalizados",
  "consola.tab.ejemplos": "Ejemplos aprobados",
  "consola.tab.entrenamiento": "Fine-tuning opcional",
  "consola.tab.lote": "Simulación en lote",
  "consola.tab.modelos": "Modelos",
  "consola.tab.reglas": "Reglas de prompt",
  "consola.tab.uso": "Uso del proveedor",
  "consola.titulo": "Consola del agente",


  // ── Lo que dice un lector de pantalla donde no hay texto ──────────
  // Un guión y un porcentaje no se leen solos en voz alta: el `aria-label` es
  // el único texto que existe ahí, así que es el que más falta hace traducir.
  "confianza.aria": "Confianza: {n}%",
  "vacio.sinDato": "Sin dato",


  // ── Las dos insignias del análisis automático, en el detalle ──────
  // Un nivel que el modelo devuelva y no esté acá se muestra crudo: el valor
  // puede cambiar del lado del modelo sin avisarle a la pantalla.
  "riesgo.fraude.high": "Riesgo alto",
  "riesgo.fraude.low": "Riesgo bajo",
  "riesgo.fraude.medium": "Riesgo medio",
  "riesgo.lesiones.fatal": "Fatal",
  "riesgo.lesiones.minor": "Leves",
  "riesgo.lesiones.none": "Sin lesiones",
  "riesgo.lesiones.severe": "Graves",


  // ── El shell — lo poco que el layout dice por sí mismo ────────────
  "layout.nombreFallback": "Analista",


  // ── Ejemplos aprobados — la solapa de la consola del agente ───────
  // `status` es `text` en la base, no un enum: un estado que no esté acá se
  // muestra crudo antes que dibujar un hueco.
  "ejemplos.aprobar": "Aprobar",
  "ejemplos.cargando": "Cargando…",
  "ejemplos.errorActualizar": "No se pudo actualizar el ejemplo.",
  "ejemplos.errorCarga": "No se pudieron cargar los ejemplos.",
  "ejemplos.estado.approved": "Aprobado",
  "ejemplos.estado.pending": "Pendiente",
  "ejemplos.estado.rejected": "Rechazado",
  "ejemplos.rechazar": "Rechazar",
  "ejemplos.sinAsunto": "(sin asunto)",
  "ejemplos.vacio.como": "Abrí un caso procesado, revisá o corregí los campos del análisis y usá",
  "ejemplos.vacio.paraQue": ". Los ejemplos aprobados se usan como contexto en las próximas ejecuciones del agente Gemini/OpenAI. El paquete de entrenamiento es opcional y portable.",
  "ejemplos.vacio.titulo": "Todavía no hay ejemplos aprobados.",
  "ejemplos.verCasos": "Ver casos",


  // ── La clave de Gemini propia de cada usuario, en configuración ───
  "claveIa.actualizar": "Actualizar clave",
  "claveIa.agregar": "Agregar clave",
  "claveIa.cancelar": "Cancelar",
  "claveIa.cifrada": ". Se almacena cifrada y nunca se comparte.",
  "claveIa.configurada": "Configurada",
  "claveIa.eliminar": "Eliminar",
  "claveIa.errorEliminar": "No se pudo eliminar la clave.",
  "claveIa.errorGuardar": "No se pudo guardar la clave. Intentá de nuevo.",
  "claveIa.guardada": "Clave guardada correctamente.",
  "claveIa.guardando": "Guardando…",
  "claveIa.guardar": "Guardar",
  "claveIa.noConfigurada": "No configurada",
  "claveIa.obtene": "Obtené tu clave en",
  "claveIa.personal": "(personal — solo usada para tus casos)",


  // ── Exportar la memoria y la configuración del agente ─────────────
  // Los valores de los desplegables —`config_only`, `masked`, `csv_summary`—
  // quedan crudos a propósito: son los parámetros que viajan a la API y los
  // que terminan en el nombre del archivo. Traducirlos sería inventar un
  // segundo vocabulario para lo mismo.
  "exportar.boton": "Exportar memoria y configuración",
  "exportar.error": "No se pudo exportar.",
  "exportar.exportando": "Exportando…",
  "exportar.formato": "Formato",
  "exportar.listo": "Export listo.",
  "exportar.pii": "Modo PII",
  "exportar.tipo": "Tipo de export",


  // ── Cambiar la contraseña, en configuración ───────────────────────
  "password.actual": "Contraseña actual",
  "password.actualPlaceholder": "Tu contraseña actual",
  "password.actualizando": "Actualizando…",
  "password.boton": "Cambiar contraseña",
  "password.confirmar": "Confirmar nueva contraseña",
  "password.confirmarPlaceholder": "Repetí la nueva contraseña",
  "password.corta": "La contraseña debe tener al menos 8 caracteres.",
  "password.errorCambio": "Error al cambiar la contraseña. Verificá que la contraseña actual sea correcta.",
  "password.errorInesperado": "Error inesperado. Intentá de nuevo.",
  "password.noCoinciden": "Las contraseñas no coinciden.",
  "password.nueva": "Nueva contraseña",
  "password.nuevaPlaceholder": "Mínimo 8 caracteres",
  "password.ok": "Contraseña actualizada. Se cerraron las sesiones abiertas en otros dispositivos —puede tardar hasta un minuto en hacerse efectivo— y en éste seguís conectado.",


  // ── Simulación en lote — la solapa que fabrica casos de prueba ────
  // Los tipos de siniestro NO se repiten acá: son los mismos `type.*` que usan
  // los filtros de la bandeja. El desplegable decía «Responsabilidad civil» y
  // el filtro «Resp. Civil» para la misma cosa.
  "lote.aleatorio": "Aleatorio",
  "lote.cantidad": "Cantidad (1–50)",
  "lote.delay": "Espera entre casos (ms)",
  "lote.descripcion": "Ejecuta N simulaciones seguidas en el servidor. No hace falta dejar la pestaña abierta: el procesamiento pasa entero por atrás.",
  "lote.errorHttp": "Error {n} al iniciar el lote.",
  "lote.errorRed": "Error de red al iniciar el lote.",
  "lote.iniciadaUna": "1 simulación iniciada",
  "lote.iniciadasVarias": "{n} simulaciones iniciadas",
  "lote.iniciando": "Iniciando lote…",
  "lote.iniciarUna": "Iniciar 1 simulación",
  "lote.iniciarVarias": "Iniciar {n} simulaciones",
  "lote.limite": "máx. 2 lotes cada 10 minutos. Cada lote puede tardar varios minutos en completarse, según Gemini. Los casos aparecen en la bandeja a medida que se procesan.",
  "lote.limiteRotulo": "Límite:",
  "lote.mas": "+{n} más",
  "lote.tipo": "Tipo de siniestro",
  "lote.titulo": "Simulación en lote — del lado del servidor",


  // ── Campos personalizados — la solapa que define qué extraer ──────
  // Los tipos de campo —`text`, `enum`, `phone`— quedan crudos: son el valor
  // que se guarda en la base y el que viaja a la API, igual que en el export.
  "campos.activar": "Activar",
  "campos.activo": "Activo",
  "campos.agregar": "Agregar",
  "campos.cargando": "Cargando…",
  "campos.col.accion": "Acción",
  "campos.col.clave": "Clave",
  "campos.col.estado": "Estado",
  "campos.col.etiqueta": "Etiqueta",
  "campos.col.siniestro": "Siniestro",
  "campos.col.tipo": "Tipo",
  "campos.desactivar": "Desactivar",
  "campos.errorActualizar": "No se pudo actualizar el campo.",
  "campos.errorCarga": "No se pudieron cargar los campos.",
  "campos.errorGuardar": "No se pudo guardar el campo.",
  "campos.guardando": "Guardando…",
  "campos.inactivo": "Inactivo",
  "campos.pedirSiFalta": "Pedir si falta",
  "campos.phClave": "clave_campo",
  "campos.phDescripcion": "Descripción",
  "campos.phEtiqueta": "Etiqueta",
  "campos.phOpciones": "opciones, separadas, por coma",
  "campos.requerido": "Requerido",


  // ── Lo que le faltaba al modal de simular un siniestro ────────────
  // El resto de `simulate.*` ya estaba arriba. Esto es lo que quedaba suelto,
  // más lo que el modal traducía con el `t` de módulo —que es siempre es-AR.
  "simulate.cancel": "Cancelar",
  "simulate.demasiadas": "Demasiadas simulaciones. Esperá un momento.",
  "simulate.elegiEscenario": "Elegí un escenario.",
  "simulate.escenarioLabel": "Escenario",
  "simulate.ingresaTexto": "Ingresá el texto del siniestro.",
  "simulate.modoEscenario": "Escenario pre-cargado",
  "simulate.modoTexto": "Texto personalizado",
  "simulate.procesando": "Procesando siniestro…",
  "simulate.textoLabel": "Texto del siniestro",
  "simulate.textoPlaceholder": "Pegá acá el texto del email del siniestro…",

} as const;

export type TranslationKey = keyof typeof esAR;
