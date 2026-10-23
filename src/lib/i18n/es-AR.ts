/**
 * UI strings — Spanish (es-AR).
 *
 * All user-facing text in ClaimMix lives here.
 * No i18n framework is used (single locale per IC7 in answers.md).
 *
 * Convention: keys use dot-notation by namespace (nav, tabs, status, etc.).
 * Use the typed `t()` helper from src/lib/i18n/index.ts for type-safe access.
 *
 * Sólo las claves que lee algún componente de cliente: este archivo viaja al
 * navegador. El texto que pinta sólo el servidor (páginas, paneles, mails) va
 * en es-AR.servidor.ts. `ClaveDelCliente` hace que un componente de cliente que
 * pida una clave del servidor no compile.
 */

export const esAR = {
  // ── App ────────────────────────────────────────────────────────────────────
  "app.name": "ClaimMix",
  "app.tagline": "Gestión inteligente de siniestros FNOL",

  // ── Navigation ─────────────────────────────────────────────────────────────
  "nav.bandeja": "Bandeja",
  "nav.escalados": "Escalados",
  "nav.noRelevantes": "No relevantes",
  "nav.miCola": "Mi cola",
  "nav.agenda": "Agenda",
  "nav.clientes": "Clientes",
  "nav.analisis": "Análisis",
  "nav.metricas": "Métricas",
  "nav.desvios": "Desvíos",
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
  "nav.altas": "Altas",
  "nav.asistente": "Asistente",

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
  "login.aviso.revisaTuCorreo": "Si esa dirección puede entrar, te mandamos un enlace para elegir tu contraseña.",
  "registro.sinContraseña.ayuda": "La contraseña la elegís desde el enlace que te llega por correo.",

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
  "status.listo_para_core": "Listo para entregar",
  "status.enviado_a_core": "Entregado al sistema central",
  "status.error_core": "Falló la entrega",
  "status.no_relevante": "No relevante",
  // Después de la entrega; los marca una persona (B25)
  "status.en_liquidacion": "En liquidación",
  "status.pagado": "Pagado",
  "status.rechazado": "Rechazado",

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
  "type.art": "ART",
  "type.vida": "Vida",
  "type.integral_comercio": "Integral de comercio",
  "type.consorcio": "Consorcio",
  "type.other": "Otro",

  // ── Dashboard tabs ─────────────────────────────────────────────────────────
  "tabs.todos": "Todos",
  "tabs.listo": "Listos",
  "tabs.esperando": "Esperando",
  "tabs.escalado": "Escalados",
  "tabs.procesando": "Procesando",
  "tabs.cerrado": "Cerrados",
  "tabs.filtrarPorEstado": "Filtrar por situación",

  // ── Case table columns ─────────────────────────────────────────────────────
  "table.col.incidentDate": "Fecha de siniestro",
  "table.col.policyholder": "Asegurado",
  "table.col.policy": "Póliza",
  "table.col.type": "Tipo",
  "table.col.status": "Situación",
  "table.col.replied": "Respondido",
  "table.replied.yes": "Respondido",
  "table.replied.pending": "Sin responder",
  "table.col.confidence": "Score",
  "table.col.age": "Antigüedad",
  "table.col.received": "Recibido",
  "table.col.assignedTo": "Asignación",
  "table.col.vencimiento": "Vence",
  "table.col.complejidad": "Complejidad",
  "table.col.motivoDescarte": "Motivo del descarte",
  "table.col.asuntoRemitente": "Asunto / remitente",
  // Respaldo cuando el caso descartado no trae un motivo propio del modelo.
  "noRelevante.motivoPorDefecto": "La IA determinó que no es una denuncia",
  "noRelevante.marcarRelevante": "Marcar como relevante",
  "noRelevante.marcado": "Marcado como relevante: vuelve al agente",

  // ── Bandeja actions ────────────────────────────────────────────────────────
  "bandeja.simulate": "Simular nuevo email",
  "bandeja.export": "Exportar CSV",
  // Placeholder y aria-label de la caja de búsqueda del encabezado: nombre,
  // póliza o número de caso («SIN-XXXX-XXXX»).
  "bandeja.buscarPlaceholder": "Buscá por nombre, póliza o número de caso",
  "bandeja.buscarLimpiar": "Limpiar búsqueda",
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
  "bandeja.paraResponder": "Para responder",
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
  "bandeja.vista.lista": "Lista",
  "bandeja.vista.tablero": "Tablero",

  // ── Tablero de la bandeja (G36) — de sólo lectura, sin arrastrar ────────────
  "tablero.verTodos": "Ver todos",
  "tablero.vacio": "Sin casos en esta columna.",

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
  "case.detail.docsGroup": "Documentación",
  "case.detail.fieldsGroup": "Datos por confirmar",
  "case.detail.confidence": "Confianza",
  "case.detail.close": "Cerrar siniestro",
  "case.detail.escalate": "Escalar",
  "case.detail.reAnalyze": "Re-analizar",
  "case.detail.reAnalyzeStarted": "Re-análisis iniciado. La página se actualizará en breve.",
  "case.detail.reAnalyzeRateLimit": "Demasiados re-análisis. Esperá una hora antes de volver a intentarlo.",
  "case.paraResponder.banner": "Llegó un mensaje después de que el agente terminó. Lo contesta una persona.",
  "case.paraResponder.marcar": "Marcar como respondido",
  "case.paraResponder.hecho": "Marcado como respondido.",
  "case.paraResponder.cambio": "El caso cambió mientras lo mirabas. Revisalo de nuevo.",
  "tardio.titulo": "Qué pide",
  "tardio.tipo.novedad_mismo_siniestro": "Novedad del mismo siniestro",
  "tardio.tipo.siniestro_nuevo": "Otro siniestro",
  "tardio.tipo.consulta_estado": "Pregunta cómo va",
  "tardio.tipo.otro": "Otra cosa",
  "tardio.tipo.sin_clasificar": "Sin clasificar",
  "case.detail.exportToCore": "Entregar al sistema central",
  "case.detail.markComplete": "Marcar completo",
  "case.detail.resolveEscalated": "Resolver escalado → Listo",
  "case.detail.processing": "Procesando...",
  "case.detail.closedBanner": "Siniestro cerrado",
  "case.detail.pagadoBanner": "Siniestro pagado",
  "case.detail.rechazadoBanner": "Siniestro rechazado",
  "case.detail.entregadoPorFuera": "Entregado por fuera: pasar a liquidación",
  "case.detail.pasarALiquidacion": "Pasar a liquidación",
  "case.detail.marcarPagado": "Marcar pagado",
  "case.detail.marcarRechazado": "Marcar rechazado",
  "case.detail.salidaConfirmar": "No se puede deshacer. ¿Confirmás?",
  "case.detail.salidaSi": "Sí, confirmar",
  "case.detail.salidaNo": "Cancelar",
  "case.detail.email": "Email",
  "case.detail.assigned": "Asignado",
  "case.detail.unassigned": "Sin asignar",
  // B9: asignación desde la ficha, sólo para el equipo.
  "asignar.rotulo": "Asignar el caso a",
  "asignar.opcion": "{nombre} ({n} abiertos)",
  "asignar.tomar": "Tomar",
  "asignar.soltar": "Soltar",
  "asignar.error": "No se pudo cambiar la asignación.",
  "case.detail.noFields": "Sin campos extraídos.",
  "case.detail.noMissingDocs": "Sin documentación pendiente.",
  "case.detail.noAuditEvents": "Sin eventos registrados.",
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
  "field.party_a_name": "Asegurado — Nombre",
  "field.party_a_plate": "Asegurado — Patente",
  "field.party_b_name": "Tercero — Nombre",
  "field.party_b_plate": "Tercero — Patente",
  "field.party_b_insurer": "Tercero — Aseguradora",
  "field.heridos_cantidad": "Cantidad de heridos",
  "field.declared_damage": "Daños declarados",
  "field.stolen_items": "Bienes sustraídos",
  "field.hail_date": "Fecha de granizo",
  "field.fire_origin": "Origen del incendio",
  "field.witnesses": "Testigos",
  "field.insurance_policy": "Póliza de seguro",
  "field.driver_name": "Nombre del conductor",
  "field.driver_license": "Licencia de conducir",
  "field.claim_type": "Tipo de siniestro",
  "field.hay_heridos": "Hay heridos",
  "field.testigos": "Testigos",
  "field.numero_denuncia": "Número de denuncia",
  "field.hora_siniestro": "Hora del siniestro",
  "field.provincia_siniestro": "Provincia",
  "field.patente_vehiculo": "Patente del vehículo",

  // ── Doc status labels ──────────────────────────────────────────────────────
  "doc.status.pending": "Falta",
  "doc.status.received": "Recibido",
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
  "close.errorFsm": "Ese cambio de situación no es válido.",

  // ── Listo para entregar: confirmación de una persona (P6) ───────────────────────
  "case.detail.confirmarListo": "Confirmar y dejar listo",
  "case.detail.confirmado": "Quedó confirmado como listo para entregar",
  "case.detail.confirmadoPor": "Confirmado por {quien}",
  "case.detail.confirmadoAnonimo": "Confirmado por el equipo",
  "case.detail.revisadoListo": "Revisado: dejar listo para entregar",
  // Dejarlo listo con datos o documentos todavía pendientes: {lista} son sus nombres.
  "listoConFaltantes.title": "¿Dejarlo listo con faltantes?",
  "listoConFaltantes.description": "Todavía falta: {lista}. El agente deja de pedirlos.",
  "listoConFaltantes.confirm": "Dejarlo listo igual",

  // ── Escalate dialog ────────────────────────────────────────────────────────
  "escalate.title": "Escalar siniestro",
  "escalate.description": "¿Escalar este siniestro para revisión manual?",
  "escalate.reason": "Motivo del escalado",
  "escalate.reasonPlaceholder": "Describí el motivo del escalado (opcional, máx. 500 caracteres)",
  "escalate.confirm": "Escalar",
  "escalate.cancel": "Cancelar",
  "escalate.success": "Siniestro escalado correctamente.",
  "escalate.error": "Error al escalar el siniestro. Intentá de nuevo.",

  // ── Tomar el control (D-F2) ──────────────────────────────────────────────────
  "case.detail.tomarElControl": "Tomar el control",
  "tomarElControl.title": "Tomar el control del caso",
  "tomarElControl.description": "Desde ahora contestás vos por WhatsApp; el agente no escribe más en este caso. En planes Pro podés devolvérselo después.",
  "tomarElControl.confirm": "Tomar el control",
  "tomarElControl.cancel": "Cancelar",

  // ── Devolver al agente (E24) ───────────────────────────────────────────────
  "case.detail.devolverAlAgente": "Devolver al agente",
  "devolverAlAgente.title": "¿Devolver el caso al agente?",
  "devolverAlAgente.description": "El agente vuelve a contestar por WhatsApp desde el próximo mensaje. Lo que escribiste vos queda en el historial.",
  "devolverAlAgente.confirm": "Devolver",

  // ── Reenviar pedido (P8) ───────────────────────────────────────────────────
  "reenvio.boton": "Reenviar pedido",
  "reenvio.reabrir": "Reabrir y reenviar",
  "reenvio.ok": "Se le volvió a pedir lo que falta",
  "reenvio.noSePuede": "No se puede reenviar el pedido ahora",
  "reenvio.reciente": "Ya se le pidió hace un momento",
  "reenvio.motivo.estado": "El caso no está esperando una respuesta",
  "reenvio.motivo.sin_destinatario": "No sabemos a quién escribirle",
  "reenvio.motivo.ventana_cerrada": "Pasaron más de 24 h desde su último mensaje de WhatsApp",
  "reenvio.motivo.plantilla_sin_aprobar": "La plantilla para escribirle después de 24 h todavía no está aprobada por Meta",
  "reenvio.motivo.plantilla_sin_respuesta": "Meta no contestó si la plantilla está aprobada: probá de nuevo en un rato",
  "reenvio.motivo.tope_de_plantillas": "Por ahora no se pueden mandar más plantillas de WhatsApp desde este espacio",
  "reenvio.motivo.nada_pendiente": "No queda nada por pedir",
  "reenvio.motivo.reciente": "Se le pidió hace menos de 10 minutos",
  "reenvio.motivo.cierre_no_es_abandono": "Lo cerró una persona: no se reabre desde acá",

  // ── Missing docs ───────────────────────────────────────────────────────────
  "docs.parte_amistoso": "Parte amistoso de accidente",
  "docs.fotos_danos": "Fotos de los daños",
  "docs.licencia_conducir": "Licencia de conducir",
  "docs.denuncia_policial": "Denuncia policial",
  "docs.fotos_lugar": "Fotos del lugar del hecho",
  "docs.certificado_medico": "Certificado médico",
  "docs.foto_vidrio": "Foto del vidrio roto",
  "docs.foto_oblea_vtv": "Foto de la oblea VTV",
  "docs.informe_bomberos": "Informe de bomberos",
  "docs.denuncia_art": "Denuncia del accidente de trabajo",
  "docs.certificado_defuncion": "Certificado de defunción",
  "docs.dni_beneficiario": "DNI del beneficiario",
  "docs.inventario_bienes": "Listado de bienes dañados o robados",
  "docs.presupuesto_reparacion": "Presupuesto de la reparación",

  // ── Confidence thresholds (UI labels) ─────────────────────────────────────
  "confidence.high": "Alta",
  "confidence.medium": "Media",
  "confidence.low": "Baja",

  // ── Supplemental pages ─────────────────────────────────────────────────────
  "analisis.title": "Análisis",
  "analisis.subtitle": "Estadísticas agregadas de siniestros",
  "admin.users.title": "Gestión de analistas",
  "admin.users.invite": "Invitar analista",

  // ── Configuración — cuenta, umbrales de IA, sistema y avisos (E10) ─
  "configuracion.alertas.titulo": "Avisos de casos urgentes",
  "configuracion.alertas.ayuda": "Un correo por línea, hasta 10. Si la dejás vacía, se avisa como hasta ahora.",
  "configuracion.alertas.guardadas": "Lista guardada.",
  "configuracion.alertas.error": "No se pudo guardar la lista.",
  "configuracion.recordatorios.titulo": "Recordatorios de lo que falta",
  "configuracion.recordatorios.ayuda": "Si el asegurado no contesta, se le vuelve a pedir lo que falta. Por WhatsApp, pasadas las 24 h, sólo con la plantilla aprobada por Meta.",
  "configuracion.recordatorios.apagado": "Apagado",
  "configuracion.recordatorios.h48": "A las 48 h",
  "configuracion.recordatorios.h48y120": "A las 48 h y a los 5 días",
  "configuracion.recordatorios.actual": "A las {horas} h (como está hoy)",
  "configuracion.core.ayuda": "Con el envío activado, «Enviar al sistema central» manda el caso firmado a la URL de tu sistema. El caso lleva datos personales del asegurado.",
  "configuracion.core.migracionPendiente": "Falta aplicar la migración 0036 (entrega al core). Hasta entonces los casos se entregan por fuera.",
  "configuracion.core.url": "URL del webhook",
  "configuracion.core.urlAyuda": "https, puerto 443 y un nombre, no una IP.",
  "configuracion.core.activar": "Enviar los casos a esta URL",
  "configuracion.core.secreto": "Secreto de firma",
  "configuracion.core.conSecreto": "Hay un secreto guardado.",
  "configuracion.core.sinSecreto": "Todavía no hay secreto.",
  "configuracion.core.generarSecreto": "Generar secreto",
  "configuracion.core.rotarSecreto": "Rotar secreto",
  "configuracion.core.probar": "Probar envío",
  "configuracion.core.pruebaOk": "El sistema central recibió la prueba.",
  "configuracion.core.pruebaFallo": "La prueba no llegó:",
  "configuracion.core.clave": "Clave de lectura (/api/v1)",
  "configuracion.core.conClave": "Clave activa:",
  "configuracion.core.sinClave": "No hay clave: nadie puede leer los casos por la API.",
  "configuracion.core.crearClave": "Crear clave",
  "configuracion.core.rotarClave": "Rotar clave",
  "configuracion.core.revocarClave": "Revocar clave",
  "configuracion.core.confirmar": "Lo que hay ahora deja de servir en el acto. ¿Seguir?",
  "configuracion.core.soloUnaVez": "Copialo ahora: no se vuelve a mostrar.",
  "configuracion.core.copiar": "Copiar",
  "configuracion.core.copiado": "Copiado",
  "configuracion.core.guardado": "Guardado.",
  "configuracion.core.error": "No se pudo guardar.",
  "configuracion.core.incompleto": "Hacen falta la URL guardada y el secreto.",
  "configuracion.core.secretoIlegible": "El secreto guardado no se puede leer: generá otro.",
  "configuracion.core.secretoNuevo": "Secreto de firma nuevo.",
  "configuracion.core.claveNueva": "Clave de lectura nueva.",
  "core.motivo.timeout": "El sistema central no contestó a tiempo.",
  "core.motivo.red": "No se pudo resolver ni conectar con el sistema central.",
  "core.motivo.destino_rechazado": "La URL del webhook no cumple las reglas: https, puerto 443 y un nombre con direcciones públicas.",
  "core.motivo.redireccion": "El sistema central respondió con una redirección, que no se sigue.",
  "core.motivo.http": "El sistema central respondió con el código HTTP {n}.",
  "core.motivo.otro": "No hay detalle del motivo.",

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
  "error.pantalla.titulo": "Algo salió mal",
  "error.pantalla.reintentar": "Reintentar",
  "error.pantalla.codigo": "Código para soporte: {codigo}",

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
  "channel.web": "Formulario web",

  // ── Bandeja filter labels ───────────────────────────────────────────────────
  "filter.channel": "Canal",
  "filter.severity": "Severidad",
  "filter.fraude": "Fraude",
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
  "filter.estado": "Situación",
  "filter.tipo": "Tipo",
  "filter.titulo": "Filtros",
  "filter.limpiar": "Limpiar",
  "filter.limpiarTodo": "Limpiar todo",
  "filter.quitar": "Quitar filtro",
  // La pista del panel: varios valores de un mismo filtro se pueden marcar a la vez.
  "filter.variosALaVez": "Podés marcar varios a la vez: por ejemplo, choque y robo.",
  // Rótulo de la marca removible de la búsqueda libre, en MarcasDeFiltros.
  "filter.busqueda": "Búsqueda",
  // B10 y B13: plazo y complejidad, sólo para el equipo.
  "filter.vencimiento": "Plazo",
  "filter.complejidad": "Complejidad",
  "vencimiento.vencidos": "Vencidos",
  "vencimiento.por_vencer": "Por vencer",
  "vencimiento.hoy": "Vence hoy",
  "vencimiento.en": "Vence en {n} d",
  "vencimiento.hace": "Vencido hace {n} d",
  "complejidad.baja": "Baja",
  "complejidad.media": "Media",
  "complejidad.alta": "Alta",
  "complejidad.puntaje": "Puntaje {n} de 100",
  // B10, B11: vencimiento, denuncia en término y plan de trabajo en la ficha.
  "plazo.art46": "Denuncia del siniestro (art. 46)",
  "plazo.art56": "Pronunciamiento del asegurador (art. 56)",
  "denuncia.dias": "{n} d del hecho a la denuncia",
  "denuncia.revisar": "{n} d del hecho a la denuncia · revisar",
  "denuncia.ayuda":
    "Señal para revisar, no una decisión. Cuenta desde la fecha del hecho que leyó el agente hasta que el caso entró a ClaimMix. El art. 46 de la Ley 17.418 da 3 días desde que el asegurado conoció el siniestro y admite excepciones; lo evalúa una persona del equipo. No se le informa al asegurado.",
  "planDeTrabajo.proximos": "Próximos pasos",
  "planDeTrabajo.hechos": "Hechos",
  "planDeTrabajo.automatico": "automático",
  "planDeTrabajo.error": "No se pudo actualizar el paso.",
  // Pestaña «Trabajo del equipo» de /agente (B9, B10, B11, B13).
  "trabajo.intro": "Cómo reparte y mide el trabajo el equipo. Todo esto es interno: no llega al asegurado.",
  "trabajo.cargando": "Cargando…",
  "trabajo.error": "No se pudo cargar la configuración de trabajo.",
  "trabajo.propio": "Configuración propia",
  "trabajo.porDefecto": "Valores por defecto",
  "trabajo.restablecer": "Volver al valor por defecto",
  "trabajo.guardado": "Guardado.",
  "trabajo.errorAlGuardar": "No se pudo guardar.",
  "trabajo.jsonInvalido": "El texto no es un JSON válido.",
  "trabajo.asignacion.titulo": "Asignación automática",
  "trabajo.asignacion.ayuda": "Sólo la hace el agente, cuando un caso llega a listo para la aseguradora o a especialista: si una persona cambia el estado, la asignación queda como está. El caso va a la persona con menos casos abiertos de la primera regla que le corresponde por tipo y turno y que tenga a alguien que edite casos. Una regla sin tipo ni turno vale para todos. Sin reglas, el caso queda sin asignar. Rige para los casos que se asignen desde ahora: no reasigna los actuales.",
  "trabajo.carga.titulo": "Carga actual",
  "trabajo.carga.abiertos": "{n} abiertos",
  "trabajo.carga.vacia": "No hay nadie del equipo para asignar.",
  "trabajo.reglas.personas": "Personas nombradas en las reglas",
  "trabajo.usuarioInexistente": "usuario inexistente",
  "trabajo.plazos.titulo": "Plazos",
  "trabajo.plazos.ayuda": "Los de la ley no se cambian. Los propios cuentan desde que el caso entra al estado de su ancla y rigen para los casos que entren a ese estado desde ahora.",
  "trabajo.plazos.legales": "De la ley (fijos)",
  "trabajo.plazos.propios": "Propios",
  "trabajo.plazos.art46": "{dias} días desde el hecho hasta la denuncia",
  "trabajo.plazos.art56": "{dias} días desde que la información está completa (listo para la aseguradora)",
  "trabajo.plan.titulo": "Plan de trabajo por tipo",
  "trabajo.plan.ayuda": "Los pasos que se arman en cada caso al llegar a listo para la aseguradora o a en liquidación, por tipo de siniestro. «*» vale para los tipos sin plan propio y un paso con «auto» se tilda solo al entrar el caso a ese estado. Los casos que ya tienen plan no se regeneran.",
  "trabajo.pesos.titulo": "Puntaje de complejidad",
  "trabajo.pesos.ayuda": "Cuánto pesa cada factor en el puntaje de 0 a 100 de cada caso.",
  "trabajo.pesos.leyenda": "Los pesos nuevos rigen desde la próxima extracción, confirmación o presupuesto de cada caso.",

  // ── Selector de período (bandeja) ──────────────────────────────────────────
  "periodo.titulo": "Período",
  "periodo.todo": "Todo",
  "periodo.hoy": "Hoy",
  "periodo.7d": "7 días",
  "periodo.30d": "30 días",
  "periodo.90d": "90 días",

  // ── Case detail email sections ──────────────────────────────────────────────
  "case.detail.severity": "Severidad",
  "case.detail.noConfirmations": "Sin confirmaciones pendientes.",
  "case.detail.noAttachments": "Sin adjuntos.",
  "case.detail.adjuntosEsperados": "Se esperan para este tipo de siniestro:",
  "case.detail.adjuntosSinEsperados": "Este tipo de siniestro no pide documentos.",
  "case.detail.confirmField": "Confirmar",
  "case.detail.rejectField": "Rechazar",
  "case.detail.fieldKey": "Campo",
  "case.detail.proposedValue": "Valor propuesto",
  "case.detail.conflictValue": "Valor en conflicto",
  "case.detail.status": "Situación",
  "case.detail.statusUpdated": "Situación actualizada.",
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
  "case.detail.coreSyncRed": "Error de red. Intentá de nuevo.",
  "case.detail.coreSyncReintentarBoton": "Reintentar",
  "case.detail.auditReason": "Motivo",
  "case.detail.technicalData": "Ver datos técnicos",
  "case.detail.motivo.processingTimeout": "El análisis tardó demasiado",
  "case.detail.motivo.conflict": "Un dato no coincide con lo que teníamos",
  "case.detail.motivo.severidad": "Severidad: {nivel}",
  "case.detail.motivo.lesiones": "Mencionó lesiones o datos de salud",
  "case.detail.motivo.entregadoPorFuera": "Entregado a la aseguradora por fuera de la app",
  "case.detail.motivo.topePorRemitente": "No se analizó: el remitente superó su cupo",
  "case.detail.motivo.topePorFormulario": "No se analizó: el formulario superó su cupo diario",
  "case.detail.motivo.clasificador": "Lo descartó el clasificador de IA",
  "case.detail.motivo.marcadoRelevante": "Lo marcó como relevante una persona",

  // ── Por qué un adjunto no quedó guardado ───────────────────────────────────
  // La fila rechazada se escribe para que el analista vea que le mandaron algo
  // y no entró. Hasta acá llegaba con el código interno en la cara —«Motivo:
  // size_exceeded»—, que no le dice a nadie qué hacer después.
  //
  // Empiezan por la CAUSA porque se leen en dos lugares: en la fila ámbar del
  // panel, que ya dice que no entró, y en el historial detrás de «Motivo:»,
  // donde un desenlace daba «Motivo: No entró: el archivo pesa…».
  //
  // Los «10 MB» son una copia a mano de `MAX_ATTACHMENT_SIZE_BYTES`
  // (`src/server/email/attachment-validator.ts`): `t()` recibe sólo una clave y
  // no interpola, así que copiar es la única opción. Quien mueva el tope tiene
  // que venir a tocar estas dos cadenas —acá y en `en-US.ts`— o empiezan a
  // mentir.
  "attachment.rejected.size_exceeded": "El archivo pesa más de 10 MB. Pedile al asegurado que lo mande más chico.",
  "attachment.rejected.content_type_not_allowed": "Es un tipo de archivo que no aceptamos. Pedile una foto o un PDF.",
  "attachment.rejected.storage_upload_failed": "No se pudo guardar. Pedile al asegurado que lo mande de nuevo.",
  "attachment.rejected.rehost_timeout": "Tardó demasiado y no se pudo guardar. Pedile al asegurado que lo mande de nuevo.",
  "attachment.rejected.aggregate_size_exceeded": "Entre todos los archivos de ese mensaje se pasaron del tope. Pedile que los mande de a uno.",
  "attachment.rejected.decode_failed": "Llegó dañado y no se pudo leer. Pedile al asegurado que lo mande de nuevo.",
  "attachment.rejected.unknown": "No se pudo guardar. Pedile al asegurado que lo mande de nuevo.",
  "attachment.rejected.download_failed": "No pudimos bajar el archivo; pedile que lo reenvíe.",

  // «Qué documento pedido cerró este adjunto» — sólo se muestra cuando el
  // agente ya lo identificó (`matched_doc_key`).
  "case.detail.reconocidoComo": "Reconocido como: {doc}",
  "attachment.duplicado": "Duplicado",
  "attachment.noSirve": "No sirve",

  "gmail.accounts.helper": "Conectá una o más casillas Gmail para crear siniestros automáticamente desde cada inbox.",
  "gmail.accounts.connect": "Conectar Gmail",
  "gmail.accounts.connectAnother": "Conectar otra cuenta",

  // ── AI provider switch ─────────────────────────────────────────────────────
  "aiProvider.title": "Modelo de IA",
  "aiProvider.helper":
    "Elegí qué proveedor de IA analiza los emails entrantes. El cambio aplica de inmediato a los próximos emails.",
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
  "aiProvider.modelo": "Modelo de Gemini",
  "aiProvider.saved": "Proveedor actualizado. Los próximos emails se analizarán con este modelo.",
  "gmail.accounts.loading": "Cargando cuentas...",
  "gmail.accounts.empty": "Todavía no hay cuentas Gmail conectadas.",
  "gmail.accounts.enabled": "Activa",
  "gmail.accounts.remove": "Eliminar",
  "gmail.accounts.connected": "Conectada",
  "gmail.accounts.pending": "Pendiente",
  "gmail.accounts.error": "Con error",
  "gmail.accounts.expired": "Vencida: Google retiró el permiso y no entra correo",
  "gmail.accounts.reconnect": "Reconectar",
  "gmail.accounts.loadError": "No se pudieron cargar las cuentas Gmail.",
  "gmail.accounts.saveError": "No se pudo actualizar la cuenta Gmail.",
  "gmail.accounts.deleteError": "No se pudo eliminar la cuenta Gmail.",

  // ── Case table "Fuente" column (W3) ─────────────────────────────────────────
  "table.col.source": "Fuente",

  // ── Provider badge labels (W3) ───────────────────────────────────────────────
  "provider.gmail": "Gmail",
  "provider.sim": "Sim",

  // ── Messages thread (W2) ────────────────────────────────────────────────────
  "messages.thread.title": "Conversación",
  "messages.thread.from": "De",
  "messages.thread.received_at": "Recibido",
  "messages.thread.attachments": "adjunto(s)",
  "messages.thread.no_subject": "(sin asunto)",
  "messages.thread.expand": "Ver más",
  "messages.thread.collapse": "Ver menos",
  "messages.thread.denunciante": "Denunciante",
  "messages.thread.agente": "Agente",
  "messages.thread.equipo": "Equipo",
  "messages.thread.no_enviado": "No se envió",
  "messages.thread.simulado": "Simulado",
  "messages.thread.transcripcion": "Transcripción de audio",
  "messages.thread.encabezadoTranscripcion": "Transcripción de nota de voz:",
  "messages.thread.sin_confirmar": "Sin confirmar",
  "messages.thread.recortada": "Se muestran sólo los mensajes más recientes.",
  "messages.thread.canalWhatsapp": "WhatsApp",
  "messages.thread.canalMail": "Mail",

  // ── Reply by WhatsApp (P8) ───────────────────────────────────────────────────
  "messages.reply.enviar": "Enviar",
  "messages.reply.placeholder": "Escribí la respuesta para el denunciante…",
  "messages.reply.ventana": "Pasaron más de 24 h desde el último mensaje: WhatsApp sólo deja escribir con una plantilla aprobada.",
  "messages.reply.agenteActivo": "El agente todavía está trabajando este caso.",
  "messages.reply.canal": "Este caso no llegó por WhatsApp.",
  "messages.reply.enviado": "Enviado.",
  "messages.reply.fallo": "No se pudo enviar. Probá de nuevo.",
  "messages.reply.venceEn": "Podés responder hasta el {fecha}.",

  // ── Customers page ──────────────────────────────────────────────────────────
  "clientes.col.policies": "Pólizas",
  "clientes.col.cases": "Casos",
  "clientes.detail.personalInfo": "Datos personales",
  // ── Las baldosas de indicador de la bandeja ─────────────────────────────────
  // Estaban escritas a mano en castellano dentro de `bandeja/page.tsx`, asi que
  // con la interfaz en ingles la fila de indicadores seguia en castellano.

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
  "agente.avisoAprendizaje": "Nada de este caso se usa solo. Si lo confirmás, el agente lo toma como ejemplo de referencia para los próximos casos de tu compañía. No se usa para entrenar ningún modelo.",
  "agente.bloqueo.invalid_json": "JSON inválido",
  "agente.bloqueo.no_linked_case": "Sin caso vinculado",
  "agente.bloqueo.not_a_claim": "No es un reclamo",
  "agente.bloqueo.prompt_injection_suspected": "Posible inyección de prompt",
  "agente.bloqueo.unresolved_conflicts": "Conflictos sin resolver",
  "agente.cargando": "Cargando análisis del agente",
  "agente.confirmando": "Confirmando…",
  "agente.confirmar": "Usar como ejemplo de referencia",
  "agente.confirmarError": "No se pudo confirmar el ejemplo.",
  "agente.confirmarOk": "Ejemplo confirmado. El agente lo usará como contexto aprobado en próximos análisis.",
  "agente.descargarJson": "Descargar JSON extraído",
  "agente.emailOriginal": "Email original analizado",
  "agente.errorCarga": "No se pudo cargar el análisis del agente. Recargá la página para reintentar.",
  "agente.cargaParcial": "Parte del análisis no se pudo cargar: lo que aparece vacío puede no estarlo. Recargá la página para reintentar.",
  "agente.faltantes": "Campos faltantes",
  "agente.jsonCrudo": "JSON extraído (crudo)",
  "agente.noSugerido": "No sugerido como ejemplo",
  "agente.pendientes": "Pendientes de confirmación",
  "agente.procesando": "El agente está procesando este email… los valores extraídos aparecerán acá automáticamente.",
  "agente.puntaje": "Puntaje",
  "agente.sinAnalisis": "Todavía no hay un análisis del agente registrado para este caso. Usá «Re-analizar» para generarlo.",
  "agente.sinCuerpo": "(sin cuerpo)",
  "agente.sinFaltantes": "Sin campos faltantes.",
  "agente.sinPendientes": "Sin campos pendientes.",
  "agente.sinValores": "El agente no extrajo valores en el último análisis.",
  "agente.sugerido": "Sugerido como ejemplo",
  "agente.valoresExtraidos": "Valores extraídos (último análisis)",
  "agente.yaConfirmado": "Ejemplo ya confirmado",

  // ── Plan Pro — las funciones que el plan abre, no un plan del catálogo ─
  "planPro.nombre": "Plan Pro",
  "planPro.bloqueado": "Disponible con el Plan Pro",
  "planPro.responder": "Responder por WhatsApp desde la app",

  // ── Alta y roles de los usuarios de una aseguradora ───────────────
  "usuarios.activo": "Activo",
  "usuarios.bloqueado": "Bloqueado",
  "usuarios.cambiarRol": "Cambiar rol de",
  "usuarios.cancelar": "Cancelar",
  "usuarios.cargando": "Cargando...",
  "usuarios.cerrandoSesiones": "Cerrando...",
  "usuarios.cerrarSesiones": "Cerrar sus sesiones",
  "usuarios.cerrarSesionesConfirmar":
    "¿Cerrar todas las sesiones de {nombre}? Va a poder volver a entrar; para dejarla afuera, dala de baja.",
  "usuarios.col.creado": "Creado",
  "usuarios.col.email": "Email",
  "usuarios.col.estado": "Estado",
  "usuarios.col.nombre": "Nombre",
  "usuarios.col.rol": "Rol",
  "usuarios.dandoDeBaja": "Dando de baja...",
  "usuarios.darDeBaja": "Dar de baja",
  "usuarios.darDeBajaConfirmar":
    "¿Dar de baja a {nombre}? Se cierran sus sesiones y no va a poder entrar por ningún camino hasta que la habilites.",
  "usuarios.deBaja": "De baja",
  "usuarios.enviandoInvitacion": "Invitando...",
  "usuarios.enviarInvitacion": "Invitar",
  "usuarios.error.baja": "No se pudo cambiar el estado del usuario.",
  "usuarios.error.crear": "No se pudo enviar la invitación. Intentá de nuevo.",
  "usuarios.error.red": "Error de red. Intentá de nuevo.",
  "usuarios.error.rol": "No se pudo actualizar el rol.",
  "usuarios.error.sesiones": "No se pudieron cerrar las sesiones.",
  "usuarios.form.email": "Correo electrónico",
  "usuarios.form.emailPlaceholder": "analista@empresa.com",
  "usuarios.form.nombre": "Nombre completo",
  "usuarios.form.nombrePlaceholder": "Ej: María García",
  "usuarios.form.rol": "Rol",
  "usuarios.habilitando": "Habilitando...",
  "usuarios.habilitar": "Habilitar",
  "usuarios.invitar": "Invitar usuario",
  "usuarios.propio": "Tu usuario",
  "usuarios.rol.admin": "Admin",
  "usuarios.rol.analyst": "Analista",
  "usuarios.rol.owner": "Owner",
  "usuarios.rol.specialist": "Especialista",
  "usuarios.rol.viewer": "Visor",
  "usuarios.rol.viewerSoloLectura": "Visor (solo lectura)",
  "usuarios.toast.creado": "Invitación enviada. La persona aparece en la lista cuando la acepte.",
  "usuarios.toast.dadoDeBaja": "Usuario dado de baja. Se cerraron sus sesiones.",
  "usuarios.toast.habilitado": "Usuario habilitado. Ya puede volver a entrar.",
  "usuarios.toast.rolActualizado": "Rol actualizado.",
  "usuarios.toast.sesionCerrada": "Se cerró 1 sesión.",
  "usuarios.toast.sesionesCerradas": "Se cerraron {n} sesiones.",
  "usuarios.vacio": "No hay usuarios registrados.",


  // ── La consola del agente — /agente, la pantalla entera ───────────
  // Distinto de `agente.*`, que es el panel de análisis adentro de un caso.
  // Acá se configura el agente; allá se lee lo que el agente extrajo.
  "consola.tab.base": "Base",
  "consola.tab.campos": "Campos personalizados",
  "consola.tab.ejemplos": "Ejemplos aprobados",
  "consola.tab.entrenamiento": "Fine-tuning opcional",
  "consola.tab.lote": "Simulación en lote",
  "consola.tab.trabajo": "Trabajo del equipo",
  "consola.pestanas": "Secciones de la consola del agente",
  "consola.tab.ramos": "Tipos de siniestro",
  "consola.tab.formulario": "Formulario web",
  "consola.tab.modelos": "Modelos",
  "consola.tab.reglas": "Reglas de prompt",
  "consola.tab.uso": "Uso del proveedor",


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
  "toast.cerrar": "Cerrar notificación",
  "toast.region": "Notificaciones",


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
  "ejemplos.vacio.paraQue": ". Los ejemplos aprobados se usan como contexto en las próximas ejecuciones del agente. El paquete de entrenamiento es opcional y portable.",
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
  "password.demasiadosIntentos": "Demasiados intentos. Esperá unos minutos y volvé a probar.",
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


  // ── Uso del proveedor — llamadas, errores y latencia de la IA ─────
  // El estado de una llamada (`success`, `rate_limited`) y el código de error
  // quedan crudos: son lo que devuelve el proveedor y lo que hay que poder
  // pegar en su documentación o en un ticket.
  "uso.actualizar": "Actualizar",
  "uso.cargando": "Cargando estadísticas…",
  "uso.cfg.backoff": "Backoff base",
  "uso.cfg.concurrencia": "Concurrencia",
  "uso.cfg.configurable": "Se configura con",
  "uso.cfg.delay": "Espera del worker",
  "uso.cfg.intervalo": "Intervalo mín.",
  "uso.cfg.reintentos": "Máx. reintentos",
  "uso.cfg.yOtras": "y otras variables de entorno.",
  "uso.col.cuota": "Cuota",
  "uso.col.error": "Error",
  "uso.col.latencia": "Latencia",
  "uso.col.modelo": "Modelo",
  "uso.col.ok": "OK",
  "uso.col.proveedor": "Proveedor",
  "uso.col.rateLimit": "Rate limit",
  "uso.col.total": "Total",
  "uso.config": "Configuración del worker Gemini",
  "uso.errorCarga": "No se pudieron cargar las estadísticas de uso.",
  "uso.erroresRecientes": "Errores recientes (24 h)",
  "uso.erroresUno": "1 error",
  "uso.erroresVarios": "{n} errores",
  "uso.rateLimited": "{n} con rate limit",
  "uso.sinErrores": "Sin errores",
  "uso.sinLlamadas": "Sin llamadas registradas.",
  "uso.subtitulo": "Llamadas, errores y latencia registrados en tiempo real.",
  "uso.titulo": "Uso del proveedor de IA",
  "uso.ultimas24": "Últimas 24 horas",
  "uso.ultimos7": "Últimos 7 días",


  // ── Reglas de prompt — lo que el asegurador le enseña al agente ───
  // `rule_type` es `text` en la base: un tipo que no esté acá se muestra crudo.
  // Los ejemplos del placeholder están escritos con el vocabulario del
  // producto, así que en inglés van con los valores en inglés.
  "reglas.activar": "Activar",
  "reglas.agregar": "Agregar regla",
  "reglas.ayuda": "Las reglas activas se incluyen en el prompt del agente para las próximas extracciones. Cada cambio queda auditado.",
  "reglas.creada": "Regla creada. Se aplicará en las próximas extracciones.",
  "reglas.desactivar": "Desactivar",
  "reglas.errorActualizar": "No se pudo actualizar la regla.",
  "reglas.errorCampos": "Completá el título y el texto de la regla (mínimo 3 caracteres).",
  "reglas.errorCarga": "No se pudieron cargar las reglas.",
  "reglas.errorCrear": "No se pudo crear la regla.",
  "reglas.guardando": "Guardando…",
  "reglas.inactiva": "Inactiva",
  "reglas.phTitulo": "Título de la regla",
  "reglas.placeholder": "Ej.: «Si el email menciona choque, clasificar como choque» · «Si hay personas heridas, severidad high o critical» · «Nunca marcar listo si falta DNI o número de póliza»",
  "reglas.tipo.classification": "Clasificación",
  "reglas.tipo.core_mapping": "Mapeo a core",
  "reglas.tipo.extraction": "Extracción",
  "reglas.tipo.missing_fields": "Campos faltantes",
  "reglas.tipo.reply_style": "Estilo de respuesta",
  "reglas.tipo.severity": "Severidad",
  "reglas.tipoRegla": "Tipo de regla",
  "reglas.vacio": "Todavía no hay reglas de entrenamiento.",


  // ── Fine-tuning — el paquete de Gemini y los trabajos de Vertex ───
  // El estado de un trabajo (`draft`, `eval_pending`, `approved`) queda crudo:
  // es el mismo que devuelve la API de Google y el que hay que poder pegar en
  // su consola cuando algo se traba.
  "ft.activarGemini": "Activar Gemini",
  "ft.actualizar": "Actualizar",
  "ft.ayuda": "Para crear un paquete primero hacen falta ejemplos aprobados. Gemini no llama a ninguna API de fine-tuning; el JSONL exportado documenta los ejemplos que ya alimentan al agente.",
  "ft.cargando": "Cargando…",
  "ft.crearGemini": "Crear paquete Gemini",
  "ft.ejemploUno": "1 ejemplo",
  "ft.ejemplosVarios": "{n} ejemplos",
  "ft.errorActualizar": "No se pudo actualizar el trabajo.",
  "ft.errorCarga": "No se pudo cargar fine-tuning.",
  "ft.errorCrear": "No se pudo crear el trabajo.",
  "ft.errorRollback": "No se pudo hacer rollback.",
  "ft.geminiActivo": "Proveedor activo: Gemini. Crear un trabajo arma un paquete contextual JSONL para evaluar, respaldar y reutilizar la memoria del agente.",
  "ft.geminiContext": "Contexto Gemini",
  "ft.sinPaquetes": "No hay paquetes de entrenamiento.",
  "ft.sinPaquetesDetalle": "Los ejemplos aprobados ya están disponibles como contexto del agente. Crear un paquete genera un JSONL portable para Gemini.",
  "ft.subtitulo": "Gemini usa los ejemplos aprobados, las reglas y la memoria como contexto activo. El paquete que se arma acá es un JSONL portable: sirve para respaldar y evaluar esa memoria, no para entrenar un modelo afuera.",
  "ft.titulo": "Entrenamiento del agente",
  "ft.vertex.activarModelo": "Activar modelo",
  "ft.vertex.activoDesde": "Activo desde {f}",
  "ft.vertex.aprobar": "Aprobar evaluación",
  "ft.vertex.cancelar": "Cancelar",
  "ft.vertex.cargando": "Cargando Vertex AI…",
  "ft.vertex.confirmar": "Confirmar",
  "ft.vertex.confirmarCosto": "Esto inicia un trabajo de fine-tuning en Google Cloud, con un costo estimado de",
  "ft.vertex.creaBorrador": "Creá un borrador para empezar.",
  "ft.vertex.crearBorrador": "Crear borrador",
  "ft.vertex.deshabilitado": "Vertex AI no está habilitado. Configurá las variables de entorno en el servidor para activarlo.",
  "ft.vertex.errorActivar": "No se pudo activar el modelo.",
  "ft.vertex.errorAprobar": "No se pudo guardar la decisión.",
  "ft.vertex.errorBorrador": "No se pudo crear el borrador.",
  "ft.vertex.errorIniciar": "No se pudo iniciar el trabajo.",
  "ft.vertex.errorSincronizar": "No se pudo sincronizar.",
  "ft.vertex.est": "est.",
  "ft.vertex.gastoTotal": "Gasto estimado total",
  "ft.vertex.habilitaPrimero": "Habilitá Vertex AI primero.",
  "ft.vertex.minEjemplos": "Mín. ejemplos:",
  "ft.vertex.modeloBase": "Modelo base:",
  "ft.vertex.precio": "y configuración de GCP. Precio estimado: US$ 0,008 cada 1.000 tokens de entrenamiento.",
  "ft.vertex.proyecto": "Proyecto:",
  "ft.vertex.rechazar": "Rechazar",
  "ft.vertex.region": "Región:",
  "ft.vertex.requiere": "Entrenamiento real por Google Cloud. Requiere",
  "ft.vertex.sinTrabajos": "No hay trabajos de Vertex AI.",
  "ft.vertex.titulo": "Vertex AI Gemini — fine-tuning supervisado",
  "ft.vertex.trabajoUno": "1 trabajo iniciado",
  "ft.vertex.trabajosVarios": "{n} trabajos iniciados",


  // ── Guardar el modelo, en el panel del proveedor ──────────────────
  // «Guardar modelos» estaba escrito a mano y sobrevivió a la pasada de i18n:
  // el archivo ya usaba `useT`, así que la medición no lo marcó.
  "aiProvider.guardando": "Guardando…",
  "aiProvider.guardarModelo": "Guardar modelo",


  // ── Las acciones de un trabajo de Vertex ──────────────────────────
  // Estaban en el bloque de fine-tuning junto a las de OpenAI. El panel de
  // Vertex las sigue usando: ahí sí hay un trabajo corriendo del otro lado.
  "ft.iniciar": "Iniciar",
  "ft.rollback": "Rollback",
  "ft.sincronizar": "Sincronizar",


  // ── La bandeja que responde al click, y la selección sin recuadros ───
  // «Actualizando…» es lo que dice la lista mientras la navegación está en
  // vuelo: el control ya cambió, el servidor todavía no contestó.
  "bandeja.actualizando": "Actualizando la lista…",
  "bandeja.listo": "Listo",
  "bandeja.marcar": "Marcar {id}",
  "bandeja.quitarSeleccion": "Quitar selección",
  "bandeja.seleccionar": "Seleccionar",
  "bandeja.seleccionarPagina": "Seleccionar los {n} de esta página",

  // ── Asistente — preguntas en lenguaje natural sobre los casos ──────────
  "asistente.titulo": "Asistente",
  "asistente.preguntaLabel": "Tu pregunta",
  "asistente.placeholder": "¿Cuántos casos hubo este mes? ¿Qué pasó con el caso de Roberto Paz?",
  "asistente.enviar": "Preguntar",
  "asistente.enviando": "Consultando…",
  "asistente.demasiadas": "Demasiadas preguntas seguidas. Esperá un momento y volvé a intentar.",
  "asistente.error": "No se pudo responder la pregunta. Probá de nuevo.",
  "asistente.avisoResumenIA": "Resumen generado con IA a partir del caso. Verificalo en el caso antes de actuar.",
  "asistente.avisoRespuestaIA": "Respuesta generada con IA a partir del caso. Verificala en el caso antes de actuar.",
  "asistente.caso.placeholder": "Preguntá sobre este caso: ¿qué falta? ¿qué dice el documento?",
  "asistente.chip.conteoMes": "¿Cuántos casos hubo este mes?",
  "asistente.chip.whatsappsHoy": "¿Cuántos WhatsApps entraron hoy?",
  "asistente.chip.reclamos30dias": "¿Cuántos reclamos hubo en los últimos 30 días?",
  "asistente.chip.buscarCasoLabel": "Buscá el caso de…",
  "asistente.chip.buscarCasoPrefill": "Buscá el caso de ",
  "asistente.chip.resumirCaso": "Resumí este caso",
  "asistente.chip.resumirCasoPregunta": "¿Qué pasó con el caso {numero}?",
  // ── Asistente flotante — el mismo asistente, en un panel sobre cualquier página ─
  "asistente.flotante.abrir": "Preguntale al asistente",
  "asistente.flotante.cerrar": "Cerrar asistente",
  "asistente.flotante.minimizar": "Ocultar el botón del asistente",
  "asistente.flotante.mostrar": "Mostrar el asistente",

  // ── Ayuda — cómo se usa la interfaz, mismo texto en la demo y en la app ─
  "ayuda.abrir": "Ayuda: cómo se usa",
  "ayuda.titulo": "Cómo se usa",
  "ayuda.cerrar": "Cerrar",
  "ayuda.paso1.titulo": "1. El siniestro llega solo",
  "ayuda.paso1.texto": "Los siniestros llegan solos por mail o WhatsApp y el agente completa los datos.",
  "ayuda.paso2.titulo": "2. La bandeja",
  "ayuda.paso2.texto": "En la bandeja filtrás por situación, tipo, severidad y canal, y de cada filtro podés marcar varios valores a la vez. «Escalados», «Para responder» y «No relevantes» de la barra son atajos a esos filtros.",
  "ayuda.paso3.titulo": "3. Confirmar un dato",
  "ayuda.paso3.texto": "Si un dato tiene confianza media o no coincide con lo que ya teníamos, el caso te pide confirmarlo: lo confirmás, corregís o rechazás desde el detalle.",
  "ayuda.paso4.titulo": "4. Derivar a un especialista",
  "ayuda.paso4.texto": "Con severidad alta o crítica, o si el reclamo menciona lesiones, el caso pasa solo a «Requiere especialista» y una persona lo revisa antes de seguir.",
  "ayuda.paso5.titulo": "5. Exportar",
  "ayuda.paso5.texto": "«Exportar» baja un CSV con los mismos filtros que estás mirando.",

  // B6, B21, B23: cobertura, monto y presupuesto del taller. Sólo para el equipo.
  "presupuesto.titulo": "Presupuesto del taller",
  "presupuesto.total": "Total",
  "presupuesto.leer": "Leer presupuesto",
  "presupuesto.releer": "Volver a leer",
  "presupuesto.leyendo": "Leyendo…",
  "presupuesto.error": "No se pudo leer el presupuesto.",
  "presupuesto.alerta.sin_danio_visible": "No se ve daño en las fotos",
  "presupuesto.alerta.item_fuera_de_rango": "Ítem por encima del rango",
  "presupuesto.alerta.total_fuera_de_rango": "Total fuera del rango orientativo",
  "presupuesto.alerta.total_no_suma": "Los ítems no suman el total",
  "presupuesto.alerta.moneda_no_comparable": "La moneda no se compara con el rango",
  "presupuesto.alerta.sin_rango": "No hay rango para comparar",
  "lectura.sinLeer.mock": "Sin leer: la IA está en modo de prueba.",
  "lectura.sinLeer.presupuesto": "Sin leer: se agotó el presupuesto de IA de la cuenta.",
  "lectura.sinLeer.cupo": "Sin leer: se llegó al tope de lecturas por hoy.",
  "lectura.sinLeer.archivo": "Sin leer: el archivo no se puede mandar al modelo.",
  "lectura.sinLeer.paginas": "Sin leer: el documento es demasiado largo para leerlo entero.",
  "lectura.sinLeer.modelo": "Sin leer: el modelo no contestó. Probá de nuevo en un rato.",
  "lectura.sinLeer.formato": "Sin leer: el modelo contestó algo que no se pudo usar.",
  "condiciones.subir": "Subir PDF de condiciones",
  "condiciones.reemplazar": "Reemplazar PDF",
  "condiciones.subiendo": "Subiendo y leyendo…",
  "condiciones.error": "No se pudo subir el PDF.",
  "configuracion.montos.titulo": "Montos orientativos",
  "configuracion.montos.ayuda": "Rango en pesos por tipo y gravedad, para ordenar el trabajo del equipo. No se le informa al asegurado. Una celda vacía usa el valor por defecto.",
  "configuracion.montos.tipo": "Tipo",
  "configuracion.montos.minimo": "Mínimo",
  "configuracion.montos.maximo": "Máximo",
  "configuracion.montos.restaurar": "Volver a los de por defecto",
  "configuracion.montos.guardados": "Guardados.",
  "configuracion.montos.error": "No se pudieron guardar.",

  // ── WhatsApp propio: rubros del perfil, los lee el cliente ──────────────────
  "waba.categoria.ALCOHOL": "Bebidas alcohólicas",
  "waba.categoria.APPAREL": "Indumentaria",
  "waba.categoria.AUTO": "Automotor",
  "waba.categoria.BEAUTY": "Belleza y cuidado personal",
  "waba.categoria.EDU": "Educación",
  "waba.categoria.ENTERTAIN": "Entretenimiento",
  "waba.categoria.EVENT_PLAN": "Organización de eventos",
  "waba.categoria.FINANCE": "Finanzas y seguros",
  "waba.categoria.GOVT": "Gobierno",
  "waba.categoria.GROCERY": "Almacén y supermercado",
  "waba.categoria.HEALTH": "Salud",
  "waba.categoria.HOTEL": "Hotelería y alojamiento",
  "waba.categoria.NONPROFIT": "Organización sin fines de lucro",
  "waba.categoria.ONLINE_GAMBLING": "Juegos de azar en línea",
  "waba.categoria.OTC_DRUGS": "Medicamentos de venta libre",
  "waba.categoria.OTHER": "Otro",
  "waba.categoria.PHYSICAL_GAMBLING": "Juegos de azar presenciales",
  "waba.categoria.PROF_SERVICES": "Servicios profesionales",
  "waba.categoria.RESTAURANT": "Gastronomía",
  "waba.categoria.RETAIL": "Comercio minorista",
  "waba.categoria.TRAVEL": "Viajes y turismo",

} as const;

export type ClaveDelCliente = keyof typeof esAR;
