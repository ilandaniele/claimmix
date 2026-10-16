# Auditoría técnica de ClaimMix (septiembre 2026)

Revisión auditada: commit `6a0023a`. Método: 9 mapas de subsistema relevados en paralelo (arquitectura, funcionalidades y dependencias), más 4 revisiones de seguridad dedicadas (autorización, entradas, agente de IA y secretos/cadena de suministro). Cada hallazgo fue verificado de forma adversarial por refutadores con voto antes de confirmarse. Resultado: 151 hallazgos confirmados y 12 refutados. Severidades corregidas: 3 HIGH, 44 MEDIUM, 104 LOW, ninguna CRITICAL.

---

## 1. Resumen de la arquitectura

ClaimMix es un SaaS Next.js 16 (App Router) multi-inquilino para toma de denuncias de seguros. Corre en Vercel, con base Postgres en Neon. La extracción de datos usa Gemini vía Vertex AI (autenticación por Workload Identity Federation, sin clave de service account), con un camino de ajuste fino (fine-tuning) propio también en Vertex.

**Capas principales:**

- **Ingesta (intake).** Dos canales de entrada. WhatsApp llega por webhook firmado de Meta Cloud API (`src/app/api/webhooks/whatsapp/route.ts`, cliente en `src/server/whatsapp/cloud-api.ts`). El mail llega por un poller incremental de Gmail (`src/server/email/gmail/gmail-poller.ts`, con marca de agua persistente en `poll-state.ts`), disparado por Pub/Sub push (`src/app/api/webhooks/gmail/route.ts`) o por un cron diario (`src/app/api/cron/gmail-poll/route.ts`). Ambos canales crean un `caso` y un `claim_message`; los adjuntos se validan (tipo, tamaño por archivo y agregado) y se suben a R2 (`src/server/email/rehost-attachments.ts`, `src/server/storage/claim-attachments-bucket.ts`).
- **Worker de extracción.** `src/app/api/worker/extract/route.ts` + `src/server/worker/extract.ts`. Toma una reserva (lease) sobre el caso para evitar dos corridas a la vez, llama a Gemini (`src/server/ai/gemini-extractor.ts`, transporte REST con reintentos, presupuesto de 30 s por llamada, `thinkingBudget` en 0) y valida la salida con Zod (`model-response.ts`). Después hace matching de cliente y póliza (`src/server/matching/*`).
- **Máquina de estados del caso (FSM).** `src/core/case/fsm.ts` define 13 estados y su tabla de transición; `AI_ALLOWED_STATUSES` limita a qué estados puede escribir el agente sin intervención humana. El orquestador post-extracción (`src/server/confirmations/orchestrate.ts`, 2264 líneas) decide entre pedir datos faltantes, escalar a `requiere_especialista` o marcar `listo_para_core`.
- **Agente de IA y deliberación.** `src/server/ai/deliberate.ts` + `agent-tools.ts` permiten hasta 3 llamadas a herramientas de solo lectura (verificar póliza, listar pólizas por DNI, historial del caso) para responder al reclamante. `compose-reply.ts` redacta el texto de salida con guardas propias (expresiones prohibidas, función `violation()`) y una plantilla determinística como piso de seguridad si la redacción por IA falla. Toda entrada no confiable (texto del reclamante, valores derivados del modelo) pasa por `sinCentinelas` (`src/core/ai/sin-centinelas.ts`) antes de entrar a un prompt, según el diseño de contención de la ADR 0004.
- **Datos y aislamiento de inquilino (tenancy).** `src/data/scope.ts` (`enTenant` / `enTenantVarias`) agrupa cada consulta con `set_config('claimmix.tenant_id', ...)` bajo un rol de base de datos restringido, `claimmix_app`, que no tiene `BYPASSRLS`. Las migraciones 0018 y 0019 fuerzan Row-Level Security (`FORCE ROW LEVEL SECURITY`) en toda tabla con `tenant_id`. La conexión `db` del dueño (que sí puede saltear RLS) sólo debe usarse con un comentario `// sin-inquilino:` que justifique la excepción (scripts administrativos, agregados de facturación, etc.).
- **Interfaz.** App Router bajo `src/app/(app)/`: bandeja de casos (`bandeja/`), detalle de caso (`casos/[id]/`), consola de agente para administradores (`agente/`), configuración, métricas y el asistente Pro (`asistente/`).
- **Integraciones.** Envío de salida por WhatsApp y Gmail (`confirmations/messenger.ts`, `email/dispatch.ts`); sincronización con el core de la aseguradora (`src/server/core-sync/*`, con un modo mock y un modo real seleccionados por `CORE_SYNC_MODE`); facturación interna (`src/server/billing/*`); y Vertex AI para el ciclo de ajuste fino (`src/server/training/vertex-ai-fine-tuning.ts`).

**Flujo típico de un caso:** un mensaje entra por WhatsApp o mail, `intake-agent.ts` o `inbound-email.ts` crea el caso y encola el worker de extracción; `extract.ts` toma la reserva, llama a Gemini y guarda los campos extraídos; `orchestrate.ts` decide el siguiente paso (pedir información, escalar a un especialista o marcar el caso listo); `messenger.ts` envía la respuesta por el canal de origen; cuando el caso está completo, un endpoint de sincronización lo manda al core de la aseguradora. Todo el camino corre dentro del contexto de tenant del caso, con RLS de punta a punta salvo los puntos `sin-inquilino` explícitamente documentados en el código.

---

## 2. Mapa de funcionalidades

La tabla cubre las funcionalidades de los 9 mapas de subsistema. El mapa de dependencias (paquetes) se desarrolla aparte en la Sección 3, para no duplicar contenido.

### 2.1 Ingesta (intake)

| Funcionalidad | Dónde vive | Entradas/salidas | Notas |
|---|---|---|---|
| Webhook WhatsApp entrante | `src/app/api/webhooks/whatsapp/route.ts` | Mensaje de Meta Cloud API firmado (o simulado con Bearer) → evento validado | Dos caminos: firma real de Meta o simulación/BSP |
| Cliente Meta Cloud API | `src/server/whatsapp/cloud-api.ts` | Verifica firma y challenge del webhook, parsea mensaje, baja media, envía texto | - |
| Agente de intake WhatsApp | `src/server/agents/intake-agent.ts` | Mensaje WhatsApp → caso + `claim_message` + adjuntos | Única entrada al worker de extracción desde WhatsApp |
| Webhook Gmail (Pub/Sub) | `src/app/api/webhooks/gmail/route.ts` | Notificación push → dispara el sondeo del buzón notificado | - |
| Cron de sondeo Gmail | `src/app/api/cron/gmail-poll/route.ts` | Cron diario (`vercel.json`, 03:00 UTC) | Renueva el watch de Gmail si vence en menos de 24 h, después sondea todas las cuentas |
| Poller de Gmail | `src/server/email/gmail/gmail-poller.ts` + `poll-state.ts` | Sincronización incremental con marca de agua persistente | Aislamiento por mensaje y lista de reintento |
| Ingesta de mail | `src/server/email/inbound-email.ts`, `thread-lookup.ts`, `relevance-prefilter.ts`, `dedupe.ts` | Mail entrante → caso nuevo o hilo existente | Hilo por id de proveedor saliente, luego `email_thread_id`, luego asunto "Caso #uuid" |
| Pipeline de adjuntos | `rehost-attachments.ts`, `attachment-validator.ts`, `gmail-attachment-adapter.ts`, `claim-attachments-bucket.ts` | Adjunto → validado (tipo, 10 MB por archivo, 25 MB agregado), deduplicado por hash, subido a R2 | - |
| Intake simulado / ensayo | `src/app/api/intake/simulate/route.ts`, `src/workflows/intake-simulado.ts`, `src/server/intake/{scenarios,simulation-throttle,batch-budget,remitente-de-ensayo}.ts` | Escenario o texto crudo → caso `email_sim` → extracción como workflow durable | Usado por el ensayo (`pnpm rehearse`) y la demo |
| Endpoint Postmark deprecado | `src/app/api/intake/email/route.ts` | Devuelve 410 | Se mantiene para que monitores externos viejos no fallen en seco |
| Worker de extracción | `src/app/api/worker/extract/route.ts` + `src/server/worker/extract.ts` | Reserva de caso → extracción con Gemini → reintentos y presupuesto de 40 s | Estados de reserva: tomada, heredada, ocupada, no se pudo; auto-redespacho |
| Barridos de recuperación | `src/server/intake/{retomar-pendientes,reap-stuck,close-abandoned}.ts` | Casos con extracción pendiente o reserva vieja → reanudados; casos trabados → reseteados; casos abandonados → cerrados | Corridos por cron |
| Mensajería saliente | `src/server/confirmations/messenger.ts` | Respuesta saliente agnóstica de canal | La plantilla es el piso de seguridad; `compose-reply` la reescribe |
| Envío de mail saliente | `src/server/email/dispatch.ts`, `gmail/gmail-sender.ts`, `gmail/gmail-client.ts` | Resuelve buzón de respuesta (valida mismo tenant), arma RFC 2822, envía, lee Message-ID | - |
| Cuentas Gmail conectadas | `src/server/email/gmail/accounts.ts` + `watch.ts` | Refresh token cifrado AES-256-GCM, alta y renovación del watch | - |
| Proveedor de mail legado | (borrado en #329) | Factory `getEmailProvider` y `SmtpSender` | Nunca se instanciaban en producción: todo envío construye `GmailSender` directo. Se borraron junto con `nodemailer` |
| Worker legado de texto | `runClaimTextAgent` en `claim-agent.ts` | Camino del viejo `simulate-flow` | `runExtractionWorker` y su test de integración se borraron en #329; `runClaimTextAgent` queda exportado sin caller de producción (Sección 15) |
| Fixtures de workflows | `src/workflows/_prueba-bitacora.ts`, `_prueba-durabilidad.ts` | Usados por los tests de `pnpm flujos` | - |

### 2.2 Agente de IA

| Funcionalidad | Dónde vive | Entradas/salidas | Notas |
|---|---|---|---|
| Fachada de extracción | `src/server/ai/claim-agent.ts` + `provider.ts#resolveExtractionEngine` | Decide motor Gemini o mock por tenant/usuario | Orden: modo mock forzado → proveedor del tenant → Vertex configurado o clave del usuario |
| Transporte Gemini | `src/server/ai/gemini-extractor.ts` | Llamada REST a Gemini | Clave de AI Studio o Bearer de Vertex (WIF); plazo 30 s, reintentos en 429/5xx/red, `thinkingBudget` 0 |
| Extracción de mail/WhatsApp | `gemini-extractor.ts#extractEmailClaimGemini`, `prompt.ts`, `model-response.ts` | Texto del reclamo → campos extraídos | 2 intentos, validación Zod, cómputo de costo |
| Camino de texto legado | `claim-agent.ts#runClaimTextAgent` → `gemini-extractor.ts`/`mock-extractor.ts` | Texto crudo → campos → análisis de faltantes → estado | Su único llamador (`runExtractionWorker`) se borró en #329; queda como deuda |
| Armado de prompt | `src/server/ai/prompt.ts` + `src/core/ai/sin-centinelas.ts` | Contexto temporal argentino, reglas, pistas de memoria → prompt con sentinelas | `sinCentinelas` neutraliza tags y comillas triples en texto de usuario antes de interpolar |
| Parseo de respuesta | `src/server/ai/model-response.ts` | JSON tolerante + validación Zod de la salida del modelo | - |
| Claves y config del proveedor | `src/server/ai/provider.ts` | Claves Gemini cifradas AES-256-GCM por usuario/tenant, selección de modelo, detección de Vertex | - |
| Presupuesto de IA | `src/server/ai/budget.ts` + `provider-usage.ts` | Tope mensual en USD, tope diario por tenant y por usuario, registro de uso | El presupuesto de demo falla cerrado; el resto falla abierto |
| Deliberación del agente | `src/server/ai/deliberate.ts` + `agent-tools.ts` | Protocolo JSON sobre la llamada a Gemini, hasta 3 llamadas de solo lectura | Coerción de plan y veto por `validate()` |
| Redacción de respuesta | `src/server/ai/compose-reply.ts` + `src/core/mensajes/*` | Texto saliente para pedido de datos, escalación o cierre | Guardas de expresiones prohibidas, 2 intentos y plantilla de respaldo |
| Clasificador de severidad | `src/server/ai/severity-classifier.ts` | Severidad por reglas propias más patrones guardados en base, se toma el máximo con la del modelo | Alimenta `requiresSpecialist` |
| Hidratación de campos | `src/server/ai/hydrate-fields.ts` | Refleja `extracted_fields` tipado en la lista `fields[]` de la UI | Depura nombre, DNI y póliza del resumen y de la respuesta sugerida |
| Extractor mock | `src/server/ai/mock-extractor.ts` | `extractEmailClaimMock` devuelve un reclamo fijo | Es el respaldo en PRODUCCIÓN cuando no hay credencial de Gemini (ver Sección 5) |
| Orquestación de intake | `src/server/agents/intake-agent.ts` | Audita la decisión del agente, corre el worker de mail; el intake de WhatsApp reusa hilo hasta 7 días | Maneja la carrera de creación de caso (error 23505) |
| Memoria de pistas | `src/server/memory/load.ts` + `update.ts` | `claim_memory`: pistas por mail o teléfono del remitente, usadas en el prompt | Se corrige con la confirmación del analista |
| Matching de cliente/póliza | `src/server/matching/customer-matcher.ts` + `policy-matcher.ts` | Busca clientes (por póliza, DNI, mail o teléfono en ese orden) y pólizas | El vínculo fuerte se limita a coincidencia por número de póliza o DNI |
| Listados de pólizas/clientes | `src/server/policies/list.ts` + `src/server/customers/list.ts` | Listado paginado con filtros normalizados | Búsqueda con `ILIKE` escapado |
| Exportación del agente | `src/server/agents/export.ts` + `training.ts` | Exporta configuración y memoria del agente en JSON/JSONL/CSV | Con máscara de PII |

### 2.3 Casos

| Funcionalidad | Dónde vive | Entradas/salidas | Notas |
|---|---|---|---|
| FSM de estados | `src/core/case/fsm.ts` | Tabla de transición, `validateTransition`/`isValidTransition` | Define estados no reabribles a mano, escalados, resueltos y permitidos para la IA |
| Reglas puras del caso | `src/core/case/*` (filtro de estado, estado tras extracción, docs y campos requeridos, análisis de faltantes, decisión de respuesta) | Reglas de negocio sin efectos secundarios | Alimentan bandeja, orquestador y UI |
| Listado de bandeja | `src/server/cases/list.ts` + `GET /api/cases` | Filtros, conteo total y conteo por estado | - |
| Export CSV | `GET /api/cases/export.csv` | Hasta 1000 filas filtradas | Protegido contra inyección de fórmulas |
| Detalle de caso | `src/server/cases/get.ts` + `detail-view.ts` + `GET /api/cases/[id]` | Caso, campos extraídos, docs faltantes, últimos 20 eventos de auditoría | Cada consulta relacionada tiene su propio dominio de error |
| Cambio de estado (PATCH) | `src/server/cases/patch.ts` + `PATCH /api/cases/:id` | Cambio de estado, asignación, confirmación de listo | Verifica dueño (`puedeCambiarEstado`) y valida contra la FSM |
| Borrado de casos | `src/server/cases/delete.ts` + `DELETE /api/cases` y `/api/cases/:id` | Borrado simple y masivo | Analistas limitados a sus propios casos en el filtro |
| Confirmación de campo | `src/server/cases/confirm-field.ts` + `/api/cases/:id/confirm-field` | Humano confirma o corrige un campo extraído | Reevalúa el estado después |
| Re-análisis | `/api/cases/[id]/re-analyze` | Reintenta la extracción con IA | Resetea a `procesando` y reencola el worker |
| Sync con el core | `src/server/core-sync/{client,mock}.ts` + `/api/cases/:id/sync-to-core` | Envía el caso al core de la aseguradora | Modo elegido por `CORE_SYNC_MODE`: sin definir da 501, `mock` usa el cliente simulado |
| Export a core | `/api/cases/[id]/export-to-core` | Devuelve el payload de exportación para el panel de UI | - |
| Orquestación post-extracción | `src/server/confirmations/orchestrate.ts` (+ `gap-analyzer.ts`, `documents.ts`) | Tras extraer: análisis de faltantes, confirmación o pedido de info, escalación, `listo_para_core` | Archivo de 2264 líneas (ver Sección 15) |
| Mensajería saliente de casos | `src/server/confirmations/messenger.ts` | Saliente por mail, WhatsApp o WhatsApp simulado + libro de salida | - |
| Reenvío de pedido | `src/server/confirmations/reenvio.ts` + `ultimo-pedido.ts` + `/api/cases/:id/reenviar-pedido` | Reenvía el último pedido de información faltante | Reabre `cerrado_por_abandono` a `info_faltante` (funcionalidad Pro) |
| Respuesta humana | `src/server/confirmations/respuesta-humana.ts` + `/responder`, `/respondido` | Respuesta humana por WhatsApp dentro de la ventana de 24 h | Cola de casos "para responder" |
| Reapertura de no relevante | `src/server/cases/reabrir-no-relevante.ts` | Reabre un caso de mail marcado `no_relevante` si llega un nuevo inbound | - |
| Auditoría condicional | `src/server/cases/auditoria-si-quedo.ts` | Inserta auditoría sólo si el UPDATE guardado hizo match | IP validada con `isIP` |
| Listados de clientes/pólizas | `/api/customers`, `/api/policies` | Listados de PII del tenant | - |
| KPIs y series | `src/server/metrics/kpis.ts` + `/api/metricas` | KPIs y series temporales del tenant | Calculado en un solo lote SQL con `enTenantVarias` |
| Fechas argentinas | `src/core/fecha/*` | Límites de día y mes en huso horario argentino | - |
| Nombre de persona | `src/core/nombres/nombre-de-persona.ts` | Valida y normaliza el nombre parseado del mail | - |

### 2.4 Autenticación y datos

| Funcionalidad | Dónde vive | Entradas/salidas | Notas |
|---|---|---|---|
| Config de Better Auth | `src/lib/auth/index.ts` | Adaptador, mail/contraseña, reset, Google, vinculación de cuenta, caché de cookie | - |
| Middleware | `src/proxy.ts` + `src/lib/security/csp.ts` | Nonce de CSP por request, headers de seguridad, páginas solo-anónimo | Redirección a `/login` en navegador |
| Sesión y roles | `src/lib/auth/{session,user-row,require-role,require-admin,require-operator,roles,exigir-plan-pro}.ts` | Búsqueda de sesión, caché de fila de usuario (TTL 30 s, 5000 entradas), guardas de rol y plan Pro | - |
| Alta y provisión | `src/lib/auth/{provision,registro-permitido}.ts` | Lista blanca de alta y aprovisionamiento de perfil | Mail verificado y en lista blanca obtiene tenant por defecto, rol analista o admin |
| Acciones de auth | `src/app/{login,registro,recuperar,restablecer}/actions.ts` | Server Actions de login, logout, Google, alta, pedido y completado de reset | - |
| Catch-all de Better Auth | `src/app/api/auth/[...all]/route.ts` | Límite de tasa en `/sign-in`, `/sign-up`, `/request-password-reset` | - |
| Perfil propio | `src/app/api/auth/me/route.ts` | GET perfil actual, PATCH del locale | - |
| Usuarios admin | `/api/admin/users`, `/api/admin/users/[id]` | Listado de usuarios del tenant, alta por admin, cambio de rol | - |
| Config de IA por usuario | `/api/user/ai-settings` | Clave de IA propia (panel en `/configuracion`) | - |
| Capa de datos | `src/lib/db/{index,helpers,paginacion,types}.ts` + `schema/*` | `db` del dueño (proxy perezoso sobre Drizzle vía `neon-http`), namespace de tablas, helpers, paginación, tipos inferidos | - |
| Scoping de tenant | `src/data/scope.ts` | `enTenant`/`enTenantVarias`: consultas con contexto de tenant bajo el rol RLS | Chequea que el rol no tenga `BYPASSRLS` |
| Esquema y RLS | `neon/migrations/0001,0004,0018,0019` + `scripts/create-app-role.mts` | Esquema, funciones de RLS, políticas de aislamiento por tenant, `FORCE RLS`, visibilidad global de `known_claim_patterns`, rol y grants | - |
| Límite de tasa | `src/lib/rate-limit/{index,postgres,memory}.ts` | Ventana fija; Postgres por defecto y falla abierto; memoria en tests | Límite de auth por IP |
| Auditoría | `src/lib/audit/{log,redact}.ts` | Escritor de auditoría de solo alta, con redacción de payload | - |
| Helpers de respuesta/seguridad | `src/lib/api/{respond,entrada}.ts` + `src/lib/security/{compare,internal-auth}.ts` | Respuesta JSON, chequeo de rol + límite por usuario en una llamada, comparación de tiempo constante, Bearer de `CRON_SECRET` | - |

### 2.5 Interfaz (UI)

| Funcionalidad | Dónde vive | Entradas/salidas | Notas |
|---|---|---|---|
| Shell de la app | `src/app/(app)/layout.tsx` + `_components/{Sidebar,TopBar,ui}.tsx` | Navegación con candados de plan Pro y por rol, barra superior, primitivas UI | - |
| Bandeja de casos | `src/app/(app)/bandeja/**` | Filtros, tabs, búsqueda, refresco en vivo, cambio de estado y borrado masivo, paginación | - |
| Detalle de caso (UI) | `src/app/(app)/casos/[id]/**` | Campos extraídos, confirmaciones, docs faltantes, adjuntos, auditoría, panel de riesgo/fraude, acciones de estado, export a core, hilo de mensajes | Página de 680 líneas |
| Configuración | `src/app/(app)/configuracion/**` | Datos de cuenta, cambio de contraseña, vínculo Google, clave Gemini personal, cuentas Gmail, umbrales de IA de solo lectura | - |
| Consola de agente | `src/app/(app)/agente/**` | Selección de proveedor, reglas de prompt, campos custom, simulación, simulación por lote, jobs de fine-tuning (Gemini y Vertex) | Sólo admin |
| Panel de KPIs | `src/app/(app)/metricas/page.tsx` | Grupos de estado, distribución por tipo, períodos | - |
| Asistente Pro (UI) | `src/app/(app)/asistente/**` + asistente flotante | Asistente de IA sobre los casos del tenant | Requiere plan Pro |
| Página de análisis vieja | `src/app/(app)/analisis/page.tsx` | Reemplazada por `/metricas` | Sin link de navegación desde el commit `75f1fe3` |
| Placeholder de dashboard | `src/app/dashboard/page.tsx` | Redirige a `/bandeja` | Placeholder |
| Internacionalización | `src/lib/i18n/*` | Diccionarios tipados de dos locales, resolución por cookie y por cuenta | - |
| Tema | `src/lib/theme/*` | Claro/oscuro por clase `.dark`, script pre-pintado con nonce | - |
| Labels y formato | `src/lib/labels/*` + `src/lib/ui/ancho-de-barra.ts` | Etiquetas de campo y formato de valores | Clases de ancho seguras para CSP |

### 2.6 Asistente Pro y facturación

| Funcionalidad | Dónde vive | Entradas/salidas | Notas |
|---|---|---|---|
| Asistente Pro (backend) | `/api/asistente` + `src/server/asistente/{responder,herramientas,prompts}.ts` + `src/core/asistente/intencion.ts` | Pregunta libre → Gemini elige una de tres herramientas fijas → consulta acotada al tenant → texto determinístico o resumen validado | - |
| Asistente (UI) | `src/app/(app)/asistente/page.tsx` + `CajaDelAsistente.tsx` + `AsistenteFlotante.tsx` | Página completa más panel flotante que reusa la misma caja | Sin plan Pro se ve un bloqueo |
| Gating de plan Pro | `src/core/billing/plan-pro.ts` + `src/lib/auth/exigir-plan-pro.ts` | `esPlanPro(plan)` verdadero para planes profesional/corporativo/enterprise | - |
| Estado de cuenta mensual | `src/server/billing/statement.ts` + `src/lib/billing/{plans,period}.ts` | Cuenta casos facturables por mes UTC, tarifa según términos del tenant, congela cada mes terminado | - |
| Cartera de tenants | `src/server/billing/tenant-summary.ts` + `admin/cartera/page.tsx` | Casos, casos facturables, total facturado, costo de IA y margen por tenant y mes | - |
| Nombre de plan | `src/lib/billing/plan-label.ts` | Nombre visible de un plan | - |
| Presupuesto de IA | `src/server/ai/budget.ts` | Tope mensual USD, tope diario por tenant y por usuario | - |
| Uso del proveedor | `src/server/ai/provider-usage.ts` + `/api/admin/provider-usage` | Log de cada llamada a Gemini (estado, latencia, error) | - |
| Alerta a especialistas | `src/server/notify/specialist-alert.ts` | Mail a especialistas (o al dueño) cuando un caso necesita atención humana | Salta casos simulados, deduplica por fila de auditoría |
| Reset de contraseña | `src/server/notify/password-reset.ts` | Callback de Better Auth: manda el link de reset | - |
| Chequeo de entrega | `src/server/notify/delivery-check.ts` | Prueba de salud que manda un mail de prueba | Enmascara el destinatario |
| KPIs de métricas | `src/server/metrics/kpis.ts` + `/metricas` | KPIs del panel, incluido el gráfico por tipo | No está gateado a plan Pro |

### 2.7 Entrenamiento y administración

| Funcionalidad | Dónde vive | Entradas/salidas | Notas |
|---|---|---|---|
| Dataset de entrenamiento | `src/server/training/{dataset,examples,trainability,sin-datos-de-la-persona}.ts` | Selecciona set aprobado (solo canales simulados, límite 500, deduplicado por sha256), trae ejemplos few-shot con PII depurada | - |
| Fine-tuning Gemini | `src/server/training/fine-tuning.ts` + `/api/admin/fine-tuning/jobs*` | Job de context-pack: arma JSONL de ejemplos aprobados | Activar fija el modelo Gemini por defecto del tenant |
| Fine-tuning Vertex | `src/server/training/vertex-ai-fine-tuning.ts` + `/api/admin/fine-tuning/vertex*` | Draft, subida de JSONL a GCS, `tuningJob` v1beta1, sync de estado, activar modelo, rollback | Ver hallazgo #86 (activación inalcanzable) |
| Corridas del agente | `src/server/training/agent-runs.ts` + `prompt-version.ts` | Log de cada corrida de extracción (versión de prompt, entrenabilidad, errores) | Última corrida por caso |
| Reglas y campos custom | `src/server/training/{prompt-rules,custom-fields}.ts` + rutas admin | CRUD de reglas de prompt y campos de extracción a nivel tenant | Alimentan el prompt del extractor |
| Ejemplos de entrenamiento | `/api/admin/training-examples` | Lista hasta 100 ejemplos, cambia estado aprobado/rechazado | - |
| Config de IA (admin) | `/api/admin/ai-settings` | Lee y cambia proveedor de IA del tenant, clave cifrada, modelo | - |
| Uso del proveedor (admin) | `/api/admin/provider-usage` | Vista admin de eventos y costos de uso del proveedor | - |
| Cuentas Gmail (admin) | `/api/admin/gmail-accounts*` | Conecta el buzón de intake por OAuth, lista, habilita/deshabilita/borra, rearma el watch | - |
| Simulación por lote | `/api/admin/batch-simulate` | Crea casos `email_sim` desde los 108 escenarios | Procesado en tandas encadenadas con `CRON_SECRET` |
| Reprocesamiento | `/api/admin/reprocess-unclassified` | Resetea casos sin clasificar a `procesando` y los redespacha | Gateado por `CRON_SECRET` |
| Credenciales GCP | `src/server/gcp/credenciales.ts` | Una sola fuente de auth GCP: OIDC de Vercel/GitHub (WIF), JSON de service account o credenciales por defecto | - |
| Storage de adjuntos | `src/server/storage/claim-attachments-bucket.ts` | Cliente R2: subir, leer, stream, borrar (sólo en prueba de salud), hash sha256 | - |
| Salud pública | `/api/admin/health` | Prueba de actividad: estado, DB, versión, timestamp | Sin autenticar (ver Sección 5) |
| Salud profunda | `/api/health`, `/api/health/delivery`, `/api/health/knock` | Chequea DB, esquema, storage, modelo, WhatsApp, Gmail, config del agente, presupuesto | Gateado por `CRON_SECRET` |
| Demo pública | `/demo` + `/api/demo/{public-analyze,analyze}` | Extracción anónima limitada a 5 por hora por IP | Presupuesto aislado en un tenant de demo |
| Export del agente | `/api/agent/export` | Exporta config del agente y ejemplos aprobados, depurados de PII | Auditado con IP del llamador |
| CSV seguro | `src/lib/csv/safe-encode.ts` | RFC 4180 con guarda contra inyección de fórmulas | - |
| Esquemas Zod | `src/lib/schemas/*` | Esquemas de auth, casos, reclamo extraído, escenarios de intake, paginación | - |

### 2.8 Scripts y CI

| Funcionalidad | Dónde vive | Entradas/salidas | Notas |
|---|---|---|---|
| Invariantes de arquitectura | `scripts/check-architecture.mjs` | 17 chequeos estáticos, incluido uso crudo de `db` | - |
| Check completo | `scripts/check-everything.mts` (`pnpm check`) | Tipos, lint, tests, ensayo contra el agente real, estado del deploy | `--local` corre un subconjunto |
| Ledger de migraciones | `scripts/migrate.mjs` + `scripts/lib/{split-sql,db-driver}.mjs` | Tabla `schema_migrations` con checksum SHA-256 | - |
| Suite de ensayo/prueba | `rehearse-*`, `smoke-production`, `knock-on-the-door`, `prove-*`, `compare-schemas` | Pruebas de punta a punta contra el agente real, tenancy/RLS y grants, paridad de esquema | - |
| Pen-test | `scripts/pen-test.mts` + `scripts/lib/rutas-api.mts` | Enumera cada `route.ts` y prueba la superficie sin autenticar | Tiene un modo profundo |
| Carga | `scripts/load-test.mts` + k6 en `tests/load/scenarios/*` | Dos stacks de prueba de carga en paralelo | - |
| Peso del bundle | `scripts/medir-peso.mjs` (`pnpm peso`) | Techo de gzip sobre `.next/static/chunks` | Techo 310 kB, medido 306 kB. `.size-limit.cjs` (tool no instalado, presupuesto distinto) se borró en #329 |
| Codemods de filtro de tenant | `migrate-tenant-filters.mjs`, `add-scope-bridge.mjs`, otros | Migración puntual de filtros `eq(tenant_id)` a scope `enTenant` | Terminada en el commit `c131854` |
| Scripts de mantenimiento de datos | `cleanup-junk-cases.mjs`, `reset-cases-keep-training.mjs`, `create-tenant.mjs` | Operaciones administrativas o destructivas ad-hoc sobre la base viva | `cleanup-cases.ts` se borró en #326 (hallazgo HIGH #100); los otros tres siguen |
| Scripts de credenciales/env | `rotar-clave-neon.mts`, `sync-vercel-env.mjs`, `switch-gcp-project.mts` | Rotación de credenciales, sync de variables de Vercel, cambio de entorno local | - |
| CI de PR/push | `.github/workflows/ci.yml` | Type-check, lint, unit, integración, cobertura, e2e, tamaño de bundle, migraciones al día, superficie de pen-test | Corre trabajo repetido (ver #101) |
| Otros workflows | `post-deploy`, `deploy-checks`, `load-tests`, `barrer-trabados`, `secrets`, `codeql`, `dependabot` | Ensayo/smoke post-deploy, barrido de casos trabados cada 15 min, escaneo de secretos y CodeQL | - |
| Config de tests | `vitest.config.ts` + `vitest.workflows.config.ts` | Tests unit e integración (jsdom) y tests de workflow durable | Piso de cobertura v8: 78/79/68/77 |
| E2E | `playwright.config.ts` + `tests/e2e/**` | E2E de navegador contra `pnpm dev` local o `pnpm start` en CI | 19 specs |
| Mocks/fixtures | `tests/mocks/*`, `tests/fixtures/*` | Mocks y fixtures compartidos entre tests | - |
| Overrides de seguridad | `package.json` (`pnpm.overrides`) + `patches/builtin-modules@5.0.0.patch` | Fijaciones de dependencias transitivas vulnerables; parche del SDK de workflow para Node 24 | - |
| Otros archivos de raíz | `.agents/skills/web-design-guidelines`, `neon/seed.sql` | Skill de agente versionada; seed del tenant demo | Usado por scripts de siembra y por tests |

---

## 3. Tecnologías y dependencias

Paquetes principales del proyecto (mapa de dependencias), con su rol y una marca cuando el hallazgo de auditoría los señala como sin uso o pesados.

| Paquete | Dónde se usa | Rol | Observación |
|---|---|---|---|
| `next` | Todo el árbol de `src/app` | Framework (App Router, Next 16) | - |
| `react` / `react-dom` | Toda la UI | Librería de UI (React 19) | - |
| `drizzle-orm` | `src/lib/db/*`, `src/data/scope.ts` | ORM y query builder sobre Postgres | - |
| `drizzle-kit` | `drizzle.config.ts` | Herramienta de generación/migración de Drizzle | Sin uso en scripts ni CI: las migraciones se escriben a mano y se aplican con `scripts/migrate.mjs` (#122, LOW). Se mantiene: es sólo de desarrollo y no entra al bundle |
| `better-auth` | `src/lib/auth/index.ts` | Autenticación (sesión, mail/contraseña, OAuth Google) | - |
| `pg` | Capa de datos, scripts | Cliente Postgres de bajo nivel | - |
| `google-auth-library` | `src/server/gcp/credenciales.ts`, Gmail | Autenticación GCP (WIF, ADC) | Mayor duplicado: conviven versiones 10 y 11 (#124, LOW) |
| `@vercel/oidc` | `src/server/gcp/credenciales.ts` | Puente OIDC de Vercel para WIF sin clave estática | - |
| `googleapis` | `src/server/email/gmail/gmail-client.ts` | Cliente de Gmail v1 + OAuth2 | Paquete de 210 MB con 338 APIs, usado sólo para Gmail; import pesado (568-688 ms) (#118, MEDIUM, ver Sección 15) |
| envío de mail saliente | `src/server/email/dispatch.ts`, `gmail/gmail-sender.ts` | Envío saliente por Gmail | El factory SMTP se borró en #329 |
| `nodemailer` | (borrado en #329) | Cliente SMTP | Sólo lo alcanzaba el factory SMTP muerto (#2, MEDIUM). Se fue con el override de `form-data` que sólo le servía a él |
| storage R2 (S3-compatible) | `src/server/storage/claim-attachments-bucket.ts` | Almacenamiento de adjuntos | - |
| `@aws-sdk/s3-request-presigner` | (borrado en #329) | URLs prefirmadas de S3 | Nunca se importaba: los adjuntos se manejan por streaming (#92/#110/#117, LOW) |
| `workflow` (SDK de workflows durables) | `src/workflows/*` | Orquestación durable del intake simulado | Requiere el parche `patches/builtin-modules@5.0.0.patch` para Node 24 |
| `@sentry/nextjs` | `sentry.server.config.ts`, `instrumentation.ts` | Observabilidad/errores | Dependencia de producción más pesada; **dormida** porque `SENTRY_DSN` no está seteado en ningún entorno (#123, LOW, ver Sección 15) |
| `pino` | (borrado en #329) | Logger estructurado | Nunca se importaba: el proyecto usa su logger propio (#110/#116, LOW) |
| `lucide-react` | UI en general | Set de iconos | Convive con un segundo set de SVG copiados a mano (#126, LOW) |
| `@tanstack/react-table` | `CasesTable.tsx` | Tabla de datos | Usado por un solo componente para renderizado simple de filas/encabezado; reemplazable (#119, LOW, ver Sección 15) |
| `zod` | Esquemas en todo el backend | Validación de esquemas | Mayor duplicado: conviven zod 3 y zod 4 (#124, LOW) |
| `dotenv` | Scripts | Carga de variables de entorno | Tres formas distintas de leer `.env.local` conviven en scripts (#125, LOW) |
| `playwright` | `tests/e2e/**` | E2E de navegador | - |
| `vitest` | Tests unit/integración | Test runner | - |
| `@testing-library/*` | Tests de componentes | Utilidades de testing de UI | - |
| `tailwindcss` | UI | Utilidades CSS | - |
| `tsx` | Scripts (`.mts`) | Ejecución de TypeScript sin compilar | - |
| `typescript` | Todo el repo | Tipado estático | - |
| `eslint` / `prettier` | Todo el repo | Lint y formato | Invariante 16 (paridad `--max-warnings`) depende de mantenerlos sincronizados con `verify` (#112, ver Sección 15) |
| `jsdom` | Tests de componentes | DOM simulado para Vitest | - |
| overrides de `pnpm` | `package.json` | Fijación de versiones transitivas vulnerables | Varios sin techo de major declarado (#103/#115, LOW, ver Secciones 5 y 6) |
| `builtin-modules` (parche local) | `patches/` | Compatibilidad del SDK de workflow con Node 24 | - |
| control de peso de bundle | `scripts/medir-peso.mjs` | Presupuesto de tamaño de cliente | `.size-limit.cjs`, config de un tool no instalado con otro presupuesto, se borró en #329 (#121, LOW) |

---

## 4. Problemas encontrados

**Por tipo (151 hallazgos confirmados):**

| Tipo | Cantidad |
|---|---|
| dead_code | 33 |
| duplicate | 24 |
| security | 20 |
| data_integrity | 14 |
| bug | 12 |
| complexity | 10 |
| unused_dependency | 7 |
| docs | 7 |
| logging | 6 |
| other | 6 |
| ai_security | 5 |
| error_handling | 4 |
| test_gap | 3 |

**Por severidad corregida:** 3 HIGH, 44 MEDIUM, 104 LOW, 0 CRITICAL. Total 151.

Los tres hallazgos HIGH y los 44 MEDIUM se listan a continuación. Los 104 LOW se listan en el **Anexo A**.

| # | Severidad | Tipo | Título | Archivo:línea | Resolución |
|---|---|---|---|---|---|
| #0 | HIGH | data_integrity | Un ingreso de mail parcial se trata después como duplicado: el cuerpo del mail se pierde para siempre y queda un caso `recibido` vacío | `src/server/email/inbound-email.ts:139` | Arreglado en #328 (G40) |
| #42 | HIGH | bug | Una cuenta con sesión pero sin fila de usuario entra en loop entre `/bandeja` y `/login` (afecta a toda alta por `/registro`) | `src/app/(app)/bandeja/page.tsx:154` | Sólo explicar: E20 |
| #100 | HIGH | data_integrity | `pnpm cleanup:cases` borra en producción `audit_log`, `training_examples` y `agent_runs` sin ninguna guarda de entorno | `scripts/cleanup-cases.ts:129` | Arreglado en #326 (G9) |
| #1 | MEDIUM | dead_code | `runExtractionWorker` legado (unas 250 líneas) y su única cadena de llamadores son inalcanzables en producción | `src/server/worker/extract.ts:140` | Arreglado en #329 (G19): `runExtractionWorker`, sus helpers y `tests/integration/worker.test.ts` borrados. `runClaimTextAgent` se borró en la limpieza de CI de octubre |
| #2 | MEDIUM | unused_dependency | `nodemailer` sólo es alcanzable a través de un factory SMTP muerto | `src/server/email/smtp/smtp-sender.ts:2` | Arreglado en #329 (G19) |
| #3 | MEDIUM | error_handling | Los fetch salientes a Meta Graph y al worker interno no tienen timeout | `src/server/whatsapp/cloud-api.ts:473` | Parcial en #326 (G41): cloud-api.ts con timeout; llamarAlWorker de gmail-poller sigue sin |
| #12 | MEDIUM | ai_security | El respaldo mock en producción devuelve un reclamo fijo (nombre y póliza de ejemplo) que puede vincularse a un asegurado real | `src/server/ai/mock-extractor.ts:384` | Sólo explicar: E16 |
| #13 | MEDIUM | dead_code | El camino legado de extracción por texto no tiene ningún llamador en producción desde el commit `84cee03` | `src/server/worker/extract.ts:140` | Arreglado: `runClaimTextAgent` y su cadena se borraron en la limpieza de CI de octubre |
| #14 | MEDIUM | bug | La clase de caracteres del escape de regex en `severity-classifier` está mal formada; patrones de base con metacaracteres no matchean o rompen | `src/server/ai/severity-classifier.ts:44` | Arreglado en #326 (G1) |
| #15 | MEDIUM | ai_security | Valores derivados del modelo se interpolan en prompts del agente sin pasar por `sinCentinelas` | `src/server/ai/deliberate.ts:304` | Parcial en #327 (G11): 2 de 4 sitios de interpolación cubiertos |
| #17 | MEDIUM | data_integrity | Los tokens gastados en intentos de extracción fallidos nunca llegan a `ai_usage`, así que el tope de presupuesto subcuenta | `src/server/ai/gemini-extractor.ts:741` | Sólo explicar: E14 |
| #26 | MEDIUM | data_integrity | El orquestador post-extracción escribe estado sin chequeo de FSM y sin guarda de estado | `src/server/confirmations/orchestrate.ts:1821` | Sólo explicar: E2 |
| #27 | MEDIUM | security | El PATCH de `/api/cases/:id` puede setear `enviado_a_core`/`error_core` directamente y simular una sincronización con el core | `src/server/cases/patch.ts:88` | Arreglado en #328 (G3) |
| #29 | MEDIUM | data_integrity | El re-análisis resetea a `procesando` cualquier estado no cerrado, incluidos `enviado_a_core` y `procesando` | `src/app/api/cases/[id]/re-analyze/route.ts:143` | Arreglado en #328 (G16) |
| #30 | MEDIUM | data_integrity | Los escritores humanos de estado no son atómicos con su auditoría y tienen ventanas TOCTOU | `src/server/cases/patch.ts:158` | Arreglado en #328 (G15) |
| #31 | MEDIUM | data_integrity | El mensajero de WhatsApp envía antes de escribir la fila del libro de salida | `src/server/confirmations/messenger.ts:514` | Arreglado en #328 (G13) |
| #32 | MEDIUM | logging | `writeAuditLog` guarda una IP sin validar en una columna `inet`; el valor `'anonymous'` descarta la fila de auditoría | `src/lib/audit/log.ts:53` | Arreglado en #328 (G14) |
| #43 | MEDIUM | security | La migración 0019 permite que cualquier sesión de tenant borre o se apropie de filas globales de `known_claim_patterns` | `neon/migrations/0019_global_rows_visible.sql:29` | Sólo explicar: E5 |
| #45 | MEDIUM | logging | El alta de usuario admin (incluso de dueños/admins) no escribe fila de auditoría | `src/app/api/admin/users/route.ts:69` | Arreglado en #326 (G7) |
| #56 | MEDIUM | bug | El gráfico por tipo de `/metricas` muestra sólo 4 de los 9 tipos de reclamo, pero sus porcentajes usan el total de los 9 | `src/app/(app)/metricas/page.tsx:131` | Arreglado en #332 (G33) |
| #57 | MEDIUM | other | Las páginas leen el locale sólo de la cookie, mientras el chrome del layout usa primero el locale de la cuenta | `src/app/(app)/bandeja/page.tsx:111` | Arreglado en #332 (G32) |
| #58 | MEDIUM | other | `/configuracion` está mayormente en español hardcodeado, y su badge de rol conoce sólo 2 de los roles | `src/app/(app)/configuracion/page.tsx:120` | Parcial en #331 (G26, G30) y #332 (G32): isAdmin unificado y textos a i18n, badge de roles sin ampliar |
| #59 | MEDIUM | other | Español hardcodeado en diálogos de cliente, panel de fraude, barra superior y `aria-label` rompe el locale en-US | `src/app/(app)/bandeja/DashboardClient.tsx:91` | Arreglado en #331 (G30) y #332 (G32) |
| #60 | MEDIUM | duplicate | Los mapas de etiqueta de tipo de reclamo y canal están reimplementados en unos 9 lugares | `src/app/(app)/casos/[id]/page.tsx:94` | Deuda: mapas de etiqueta reimplementados en 9 lugares, no cubierto |
| #61 | MEDIUM | duplicate | Tres indicadores de confianza con umbrales y accesibilidad distintos | `src/app/(app)/casos/[id]/_components/FieldConfirmationsPanel.tsx:44` | Deuda: tres indicadores de confianza distintos, no cubierto |
| #62 | MEDIUM | duplicate | Chequeos y tipos de rol redeclarados en vez de usar `lib/auth/roles` | `src/app/(app)/casos/[id]/page.tsx:146` | Deuda: chequeos de rol redeclarados, no cubierto |
| #71 | MEDIUM | bug | El gráfico por tipo de `/metricas` renderiza sólo 4 de 9 tipos de reclamo pero toma porcentajes sobre los 9 | `src/app/(app)/metricas/page.tsx:436` | Arreglado en #332 (G33) |
| #72 | MEDIUM | security | El uso del modelo por el asistente se registra con `user_id` nulo, así que el tope diario de tokens por usuario nunca lo cuenta | `src/server/asistente/responder.ts:139` | Sólo explicar: E11 |
| #75 | MEDIUM | bug | `/admin/cartera?month=garbage` rompe: se aplica una aserción de no-nulo sobre un parseo que puede ser nulo | `src/server/billing/tenant-summary.ts:57` | Arreglado en #328 (G17) |
| #76 | MEDIUM | data_integrity | Cualquier mes terminado, incluidos meses previos a la existencia del tenant, se congela a la tarifa mensual completa en su primera vista | `src/server/billing/statement.ts:150` | Sólo explicar: E15 |
| #85 | MEDIUM | bug | La UI de jobs de Vertex lee campos que la API nunca devuelve, así que los botones de Sync y Activar quedan siempre deshabilitados | `src/app/(app)/agente/FineTuneJobsPanel.tsx:252` | Sólo explicar: E18 |
| #86 | MEDIUM | bug | Ningún camino de código mueve un job de Vertex a `approved`, así que la activación es inalcanzable; el sync además regresa jobs `approved`/`deployed` | `src/server/training/vertex-ai-fine-tuning.ts:625` | Sólo explicar: E18 |
| #88 | MEDIUM | test_gap | No hay tests para ninguna función del ciclo de vida de fine-tuning (Gemini o Vertex) | `src/server/training/vertex-ai-fine-tuning.ts:491` | Deuda: sin tests del ciclo de vida de fine-tuning |
| #89 | MEDIUM | data_integrity | Iniciar/activar de Gemini acepta el id de job de cualquier proveedor; activar un id de Vertex cambia la config del modelo del tenant mientras la actualización de estado no hace nada | `src/server/training/fine-tuning.ts:247` | Sólo explicar: E18 |
| #90 | MEDIUM | duplicate | `/api/health` reimplementa la suma de gasto mensual y parsea el tope distinto (reporta `MONTHLY_BUDGET_USD=0` contra 200) | `src/app/api/health/route.ts:525` | Deuda: /api/health reimplementa la suma de presupuesto, sin cubrir |
| #91 | MEDIUM | dead_code | `/api/demo/analyze` no tiene llamadores pero es un endpoint vivo que gasta presupuesto para cualquier rol, y loguea el texto del mensaje del proveedor | `src/app/api/demo/analyze/route.ts:152` | Sólo explicar: E9 |
| #101 | MEDIUM | complexity | CI corre el mismo trabajo varias veces, lo que ahora gasta minutos medidos de Actions en el repo privado | `.github/workflows/ci.yml:817` | Sólo explicar: E13 |
| #102 | MEDIUM | docs | El README le dice al lector que vuelva a correr cada migración a mano con `psql`, salteando el ledger, y documenta OpenAI y filtros de tenant a nivel de aplicación | `README.md:48` | Arreglado en #331 (G31) |
| #104 | MEDIUM | test_gap | La autorización por ruta y el IDOR no están testeados; la guarda contra escalamiento de dueño en el PATCH de `admin/users/[id]` no tiene test | `src/app/api/admin/users/[id]/route.ts:71` | Deuda: autorización e IDOR por ruta sin test sistemático |
| #105 | MEDIUM | duplicate | El puente de test de `@/data/scope` está copiado y pegado en 85 archivos y resuelve thenables, lo que ya escondió 15 consultas rotas en producción | `scripts/add-scope-bridge.mjs:1` | Sólo explicar: E22 |
| #106 | MEDIUM | data_integrity | Playwright reusa un servidor de desarrollo local corriendo, lo que saltea el override de `DATABASE_URL` y escribe en producción | `playwright.config.ts:53` | Sólo explicar: E7 |
| #114 | MEDIUM | dead_code | `nodemailer` + `SmtpSender` son inalcanzables en producción: todo camino de envío construye `GmailSender` directo | `src/server/email/gmail/index.ts:37` | Arreglado en #329 (G19) |
| #118 | MEDIUM | complexity | `googleapis` (210 MB, 338 APIs, 568-688 ms de import) se usa sólo para Gmail v1 + OAuth2 | `src/server/email/gmail/gmail-client.ts:16` | Sólo explicar: E19 |
| #127 | MEDIUM | bug | El re-análisis deja que un analista cambie el estado de casos que no tiene asignados | `src/app/api/cases/[id]/re-analyze/route.ts:146` | Sólo explicar: E3 |
| #134 | MEDIUM | security | Los adjuntos de Gmail se bajan completos antes de cualquier chequeo de tamaño (`part.body.size` se ignora) | `src/server/email/gmail/gmail-attachment-adapter.ts:168` | Sólo explicar: E8 |
| #139 | MEDIUM | bug | La guarda de respaldo-por-búsqueda acepta valores que sólo aparecen en los propios argumentos de herramienta del modelo | `src/core/case/respaldado-por-busqueda.ts:54` | Arreglado en #327 (G10) |
| #140 | MEDIUM | ai_security | Sin tope por remitente en el webhook de WhatsApp: un teléfono puede agotar el presupuesto de IA del tenant y dejar cada caso posterior estacionado en `escalado` | `src/app/api/webhooks/whatsapp/route.ts:323` | Sólo explicar: E12 |

---

## 5. Riesgos de seguridad

Los 25 hallazgos de las categorías `security` y `ai_security`, agrupados por dimensión.

### 5.1 Autorización

**Uso inconsistente del dueño del caso.** El analista puede reabrir/cambiar el estado de casos que no le fueron asignados por caminos distintos del PATCH principal: `responder/route.ts` no aplica la misma regla de dueño (#40, `src/app/api/cases/[id]/responder/route.ts`), y `sync-to-core` deja el flag `force` disponible sin exigir rol admin, saltando la FSM (#28, `src/app/api/cases/[id]/sync-to-core/route.ts:102`). Impacto: un analista puede tocar casos ajenos. Sólo explicar: E25 Sólo explicar: E25

**Escritura directa de campos de sincronización.** El PATCH de `/api/cases/:id` permite setear `enviado_a_core`/`error_core` sin pasar por el sync real, simulando que el caso ya se mandó al core (#27, `src/server/cases/patch.ts:88`). Impacto: datos de integración falseables desde la API de casos. Arreglado en #328 (G3)

**Filas globales sin protección por tenant.** La migración 0019 deja que cualquier sesión de tenant borre o tome control de filas globales de `known_claim_patterns`, pensadas para ser compartidas entre tenants (#43, `neon/migrations/0019_global_rows_visible.sql:29`). Impacto: un tenant puede degradar datos usados por todos. Sólo explicar: E5

**Rutas sin límite de tasa ni auditoría.** `export-to-core` y `/api/metricas` saltean el guardián común `entrar()`, así que no tienen límite de tasa; las exportaciones de PII no dejan rastro de auditoría (#33, `src/app/api/cases/[id]/export-to-core/route.ts:41`). Impacto: exfiltración de datos sin traza ni freno. Deuda: export-to-core sin entrar()/rate limit ni auditoría, no cubierto

**Buckets de límite de tasa de auth partidos.** Login y reset de contraseña vía Server Action no comparten el bucket de límite de tasa con la ruta HTTP, y el límite de reset se calcula por (IP, dirección) en vez de por dirección sola (#44, `src/app/api/auth/[...all]/route.ts:75`). Impacto: el límite real de intentos es más alto que el nominal. Sólo explicar: E21

**Auditoría de sólo-alta que no es tal a nivel de base.** El rol `claimmix_app` tiene privilegios UPDATE/DELETE sobre `audit_log`; que sea append-only depende sólo de que el código nunca los use (#47, `scripts/create-app-role.mts:91`). Impacto: si un bug o una consulta cruda escribe sobre `audit_log`, no hay barrera de base que lo impida. Sólo explicar: E6

**Imports sin uso del cliente sin-tenant.** Varios módulos con alcance de tenant importan el cliente `db` (que puede saltear RLS) a nivel de archivo sin usarlo (#22, `src/server/ai/agent-tools.ts:29`). Impacto: superficie latente para que un cambio futuro use por error la conexión sin RLS. Arreglado en #330 (G23)

**Recipientes de alerta compartidos entre tenants.** `SPECIALIST_ALERT_EMAILS` es una lista global de variable de entorno que sobreescribe los destinatarios de alerta de todos los tenants (#73, `src/server/notify/specialist-alert.ts:60`). Impacto: un tenant puede recibir alertas (y metadatos) de casos de otro tenant. Sólo explicar: E10

**Endpoint público que expone detalle de error de base.** `/api/admin/health`, sin autenticar, devuelve el texto crudo del error de base cuando la conexión falla (#87, `src/app/api/admin/health/route.ts:49`). Impacto: revela detalles internos de infraestructura a cualquier visitante. Arreglado en #326 (G4) y #333 (G37)

### 5.2 Inyección y entradas no confiables

**Adjuntos descargados enteros antes de validar tamaño.** El adaptador de adjuntos de Gmail baja el archivo completo antes de mirar `part.body.size` (#134, `src/server/email/gmail/gmail-attachment-adapter.ts:168`). Impacto: un adjunto armado a propósito puede forzar descarga y procesamiento de payloads grandes antes de ser rechazado. Sólo explicar: E8

**Cabeceras de mail salientes sin guarda anti-inyección.** Las líneas RFC 2822 se concatenan a partir de valores derivados del mail entrante, sin chequeo de CR/LF (#136, `src/server/email/gmail/gmail-sender.ts:79`). Impacto: riesgo de inyección de cabeceras si un valor entrante contiene saltos de línea. Arreglado en #326 (G5)

**Expresiones interpoladas directo en scripts de workflow.** `load-tests.yml` interpola expresiones de GitHub Actions directamente dentro de bloques `run:`, contra la convención propia del repo de pasarlas por variables de entorno (#148, `.github/workflows/load-tests.yml:100`). Impacto: superficie de inyección de comandos si el valor interpolado viene de un contexto controlable por quien dispara el workflow. Sólo explicar: E13

### 5.3 Agente de IA y prompt injection

**Respaldo mock fabrica un reclamo fijo en producción.** Cuando no hay credencial de Gemini disponible, el extractor mock devuelve un reclamo con nombre y número de póliza de ejemplo en vez de fallar (#12, `src/server/ai/mock-extractor.ts:384`). Impacto: ese caso puede terminar vinculado por error a un asegurado real que comparte el número de ejemplo. Sólo explicar: E16

**Valores del modelo interpolados sin sentinelas.** Tanto en el planificador como en el compositor, `deliberate.ts` interpola valores ya derivados del propio modelo (`knownValues`) en el siguiente prompt sin pasarlos por `sinCentinelas`, a diferencia del resto de las entradas (#15 y su duplicado #144, `src/server/ai/deliberate.ts:304`). Impacto: rompe la regla de contención uniforme de la ADR 0004 para ese camino puntual. Parcial en #327 (G11): 2 de 4 sitios de interpolación cubiertos

**Consumo del asistente sin atribuir a usuario.** El uso del modelo por el asistente Pro se registra con `user_id` nulo, así que el tope diario de tokens por usuario nunca contabiliza ese consumo (#72, `src/server/asistente/responder.ts:139`). Impacto: un usuario puede exceder su tope individual sin que el sistema lo detecte. Sólo explicar: E11

**Sin tope de consumo por remitente en WhatsApp.** El webhook de WhatsApp no limita cuántas veces un mismo número dispara extracción, así que un solo remitente puede agotar el presupuesto de IA del tenant y dejar casos posteriores estacionados en `escalado` (#140, `src/app/api/webhooks/whatsapp/route.ts:323`). Impacto: negación de servicio del canal de IA para todo el tenant (OWASP LLM10, consumo sin límite). Sólo explicar: E12

**Guarda de resumen del asistente incompleta.** La guarda que evita que el asistente repita datos sensibles sólo rechaza corridas de 8 o más dígitos; montos con puntos o de 7 dígitos escritos por el reclamante pueden colarse como hechos del caso (#142, `src/server/asistente/responder.ts:99`). Impacto: fuga parcial de datos potencialmente sensibles en el resumen generado. Arreglado en #327 (G12)

### 5.4 Secretos

**Endpoint público con volcado de error de base.** Ver también 5.1: `/api/admin/health` expone texto de error interno sin autenticar (#87). Arreglado en #326 (G4) y #333 (G37)

**URLs de base de staging/E2E en el entorno del job.** Las URLs de base de staging y E2E están en el entorno a nivel de job, expuestas a los scripts de ciclo de vida de `pnpm install` y a cualquier paso del job (#145, `.github/workflows/ci.yml:251`). Impacto: cualquier dependencia con script de instalación comprometido en ese job podría leer esas URLs. Sólo explicar: E13

**Secreto de cron enviable a host arbitrario.** Las entradas de URL del `workflow_dispatch` de `barrer-trabados.yml` mandan `CRON_SECRET` a cualquier host que se ingrese; sólo `load-tests` valida el host de destino (#147, `.github/workflows/barrer-trabados.yml:103`). Impacto: quien dispare manualmente ese workflow puede filtrar el secreto a un host propio. Sólo explicar: E13

**Contraseña de rol de aplicación en texto plano dentro de una sentencia DDL.** El script que crea el rol de base escribe la contraseña en texto plano dentro del texto de la sentencia SQL (#150, `scripts/create-app-role.mts:72`). Impacto: la contraseña puede quedar en logs o en el historial de la sesión SQL. Deuda: password del rol de la app viaja en texto plano en el DDL

### 5.5 Cadena de suministro

**Overrides de dependencias sin techo de major.** Varios overrides de `pnpm` no tienen techo de versión mayor y fuerzan majors que los propios dependientes nunca declararon, contra la regla que el repo se puso a sí mismo (#115, `package.json:130`). Impacto: una actualización transitiva podría saltar a una versión mayor incompatible sin que nada lo frene. Deuda: cuatro overrides sin techo de major, sin cubrir

**Scripts de instalación sin lista blanca.** `pnpm` corre los scripts de instalación de cada dependencia sin ninguna lista blanca ni `ignore-scripts` (#146, `package.json:114`). Impacto: cualquier dependencia (directa o transitiva) puede ejecutar código arbitrario en el momento de instalar. Sólo explicar: E13

---

## 6. Dependencias innecesarias

Los 7 hallazgos de tipo `unused_dependency`, con la evidencia de por qué no se usan. Tres de ellos señalan en el fondo el mismo paquete (`@aws-sdk/s3-request-presigner`) y dos señalan `pino`; se listan todos porque cada uno aporta una línea de evidencia distinta.

**Resultado:** `nodemailer`, `@aws-sdk/s3-request-presigner` y `pino` se borraron en #329 (con el override de `form-data`, que sólo servía a `nodemailer`). `drizzle-kit` se mantiene: es una dependencia de desarrollo, no entra al bundle y el dueño puede usar `drizzle-kit studio` a mano.

| # | Paquete | Severidad | Evidencia | Archivo |
|---|---|---|---|---|
| #2 | `nodemailer` | MEDIUM | Sólo alcanzable a través de `SmtpSender`, que ningún camino de envío en producción instancia: todos construyen `GmailSender` directo | `src/server/email/smtp/smtp-sender.ts:2` |
| #92 | `@aws-sdk/s3-request-presigner` | LOW | Nunca se importa en el código; los adjuntos se manejan por streaming, no por URL prefirmada | `package.json:72` |
| #103 | `nanoid`, `js-yaml`, `form-data` (overrides) | LOW | Overrides de `pnpm` sin techo de major que cruzan versiones mayores contra los rangos declarados; el override de `form-data` apunta a un paquete fuera del árbol de dependencias | `package.json:130` |
| #110 | `pino`, `@aws-sdk/s3-request-presigner` | LOW | Ambas son dependencias de runtime declaradas sin ningún import en el código | `package.json:84` |
| #116 | `pino` | LOW | Dependencia de producción nunca importada; el proyecto usa un logger propio hand-rolled | `package.json:84` |
| #117 | `@aws-sdk/s3-request-presigner` | LOW | Nunca importado; confirma #92/#110 desde otro ángulo del mapeo | `package.json:72` |
| #122 | `drizzle-kit` | LOW | `drizzle.config.ts` sin uso: las migraciones se escriben a mano y se aplican con `scripts/migrate.mjs`; ningún script, CI ni doc invoca `drizzle-kit` | `drizzle.config.ts:1` |

---

## 7. Código muerto eliminado

Cada borrado se comprobó antes con `rg -nw <símbolo> src scripts tests`: sólo aparecían la definición y los tests del propio símbolo, que se fueron con él. Ninguno cambia comportamiento; el build, las 84 rutas y el peso del bundle (306 kB) quedan iguales.

| Qué | Dónde | PR | Hallazgos |
|---|---|---|---|
| Remitente SMTP y su fábrica (`getEmailProvider`, `SmtpSender`) | `src/server/email/smtp/smtp-sender.ts`, `src/server/email/gmail/index.ts` | #329 | #2, #114 |
| `runExtractionWorker` (unas 250 líneas) y sus helpers privados, con su test de integración | `src/server/worker/extract.ts`, `tests/integration/worker.test.ts` | #329 | #1 |
| Exports sin importadores: `dedupe`, `buildSafeDefault`, `extractJsonObjectText`, `seedMemoryFromExtraction`, `COST_PER_*`, `hasProviderKey`, `CaseStatusEmail`, 56 tipos de `db/types.ts`, re-export de `stripQuotedReply` | `src/server/{email,ai,memory,worker}`, `src/core/case/fsm.ts`, `src/lib/{db,schemas,labels}` | #329 | G19/G20 |
| `SignInForm.tsx` y exports muertos de la bandeja y de `ui.tsx` | `src/app/(auth)/sign-in/`, `src/app/(app)/bandeja/components/`, `src/app/(app)/_components/ui.tsx` | #329 | G20 |
| Scripts de la migración de filtros de tenant, ya aplicada (`analyze-tenant-filters`, `migrate-tenant-filters`, `declare-tenant-ctx`) con sus entradas de `package.json` | `scripts/` | #329 | G21 |
| `.size-limit.cjs`, `tests/fixtures/tenants.sql`, `tests/mocks/db.ts` | raíz y `tests/` | #329 | #111, #121 |
| `scripts/cleanup-cases.ts` y su script `cleanup:cases`: borraba en la base viva todos los casos del tenant, con `audit_log`, `training_examples` y `agent_runs`, sin guarda de entorno | `scripts/` | #326 | #100 (HIGH) |
| Dependencias `nodemailer`, `pino`, `@aws-sdk/s3-request-presigner` y el override de `form-data` | `package.json`, `pnpm-lock.yaml` | #329 | #2, #92, #110, #116, #117 |
| 88 imports sin uso en 64 archivos (los que marca `tsc --noUnusedLocals`) | `src/`, `tests/` | #330 | G23 |
| Respaldos `|| "Texto"` de la barra lateral que nunca actuaban (las claves existen en los tres idiomas) | `src/app/(app)/_components/Sidebar.tsx` | #331 | G27 |

Se mantienen a propósito:
- `scripts/sync-vercel-env.mjs`: el dueño lo corre a mano.
- `drizzle-kit` y `drizzle.config.ts`: dependencia de desarrollo, no entra al bundle (#122).
- `runClaimTextAgent`: quedó sin caller de producción al borrarse `runExtractionWorker`, pero dos tests lo mockean y tiene el bug #18 sin corregir. Borrarlo es el próximo paso natural (Sección 15).
- Las otras 24 marcas de `tsc --noUnusedLocals` (variables, funciones y tipos locales): sacarlas pide leer cada caso.

## 8. Duplicados consolidados

| Duplicado | Ahora vive en | Antes | PR |
|---|---|---|---|
| Escape de caracteres para `RegExp` | `src/core/text/escapar-regex.ts` | El clasificador de gravedad y cuatro sitios de `hydrate-fields.ts`, con una variante que armaba mal la clase de caracteres (#3 de G1) | #326 (arreglo), #331 (consolidación) |
| Código de error para logs (`errorCode(err)`) | `src/lib/observability/error-code.ts` | 22 copias privadas de la misma función | #331 |
| `firstRow` en el export de casos | `@/lib/db/helpers` | Copia local en `export.ts` | #331 |
| Cierre del envío saliente de mail (actualizar `claim_messages` y `outbound_messages`, auditar) | `finalizeOutbound`, privada de `src/server/email/dispatch.ts` | El mismo bloque en la rama de éxito y en la de falla del envío | #331 |
| Marcar leído un mail en Gmail | `markMessageRead` en `src/server/email/gmail/gmail-poller.ts` | Dos llamadas armadas a mano en el poller | #331 |
| Comparación de DNI, teléfono y póliza en SQL | `digitsOnlyEquals` y `policyNumberEquals` en `@/lib/db/helpers` | El mismo `regexp_replace` o `upper(replace(...))` escrito en seis módulos (agente, asistente, confirmaciones, clientes, matching, pólizas) | #331 |
| Corte 80/20 del dataset de entrenamiento y lista de estados de job abierto | `splitJsonl` y `OPEN_JOB_STATUSES` en `src/server/training/dataset.ts` | Copias idénticas en `fine-tuning.ts` y `vertex-ai-fine-tuning.ts` | #331 |
| Listas válidas de estado, gravedad y canal de la bandeja | Derivadas de los schemas (`ChannelSchema` nuevo en `src/lib/schemas/cases.ts`) | Arrays escritos a mano en la página | #331 |
| Chequeo de admin en `/configuracion` | `esAdmin` existente | Comparación de roles inline | #331 |
| Idioma de las páginas de la app | `getAccountLocale()` en `src/server/i18n/idioma-de-la-cuenta.ts` | El layout leía el idioma de la cuenta y once páginas leían sólo la cookie | #332 |

No se consolidó, con motivo:
- **Los tres parsers de `ADMIN_EMAILS`.** Una tabla de caracterización (`tests/unit/admin-emails-tres-parsers.test.ts`) muestra que dan resultados distintos ante mayúsculas, espacios y separadores. Unificarlos cambiaría quién es admin en algún entorno. Queda documentado para una decisión explícita.
- **El puente de test de `@/data/scope` copiado en 85 archivos (#105).** Toca el aislamiento por RLS de cada test; ver E22.
- **Los mapas de etiqueta de tipo y canal reimplementados en 9 lugares (#60).** Unificarlos cambia textos visibles en algunos lugares; queda como deuda (Sección 15).

## 9. Simplificaciones

- **Barra lateral** (#331): sin respaldos muertos, y el enlace activo lleva `aria-current="page"`.
- **Mensajero de WhatsApp** (#331): registra el resultado del envío con el `logger` del proyecto en vez de `console`, con el detalle del error recortado a 200 caracteres.
- **Panel de fraude del caso** (#331): los textos pasan a i18n (`case.detail.fraudAnalysis`, `fraudDisclaimer`, `fraudNoDetails`). El texto en es-AR queda idéntico, byte a byte.
- **`/metricas`** (#332): la distribución por tipo lista los nueve tipos de `ClaimTypeSchema` en lugar de cuatro fijos, y cuenta sólo mensajes que son siniestros.
- **Documentación** (#331): ADR 0001, 0003 y 0004, README y ARQUITECTURA al día. Se sacaron las menciones a OpenAI (fuera del stack), los comentarios "RLS is gone" y los topes viejos. `.env.example` documenta 27 variables que el código lee; van comentadas para que un `cp .env.example .env.local` no pise valores por omisión con cadenas vacías.
- **Imports** (#330): 88 imports sin uso menos, en 64 archivos.

## 10. Mejoras de arquitectura

Todas son aditivas o reemplazan una implementación por otra con el mismo contrato. Ningún campo, estado, endpoint ni variable de entorno cambió de nombre.

- **Escrituras de estado atómicas** (#328). El PATCH de casos y el re-análisis condicionan el `UPDATE` al estado leído. Si otro usuario cambió el caso en el medio, el PATCH responde 409 en vez de pisarlo. `enviado_a_core` y `error_core` dejaron de ser escribibles desde la API: sólo los escribe la integración con Core.
- **Orden del mensajero de WhatsApp** (#328). La fila `queued` se escribe antes de mandar y se actualiza después. Si el insert falla, el mensaje igual sale y la fila se escribe al final: nunca se pierde un envío por un problema de la base.
- **Ingreso de mail ante una carrera** (#328, hallazgo HIGH #0). Si el caso ya existe por el mismo `messageId` y todavía no tiene ese mensaje, el ingreso sigue con ese caso. Antes el mail se descartaba y quedaba un caso `recibido` vacío.
- **Frontera de datos del denunciante hacia el modelo** (#327). Los valores conocidos y los valores en conflicto pasan por `sinCentinelas` antes de entrar al prompt. La deliberación ya no toma como respaldo los argumentos que escribió el propio modelo. El resumen del asistente se descarta si afirma un monto o un número largo que no está en la póliza ni en el caso.
- **Salidas de red con plazo** (#326). Los tres `fetch` a la Graph API de WhatsApp cortan a los 30 s con `AbortSignal.timeout`, con el mismo contrato `{ok, error}`.
- **Idioma por cuenta** (#332). Una sola función decide el idioma de toda página de la app. Un test falla si una página vuelve a leer sólo la cookie.
- **Funciones nuevas pedidas por el dueño** (#333, #334). Ninguna agrega endpoint, estado, tabla ni variable de entorno:
  - **Filtro por riesgo de fraude (G35, #333).** `fraude` se suma a `CaseQuerySchema` y a `listCases`. La bandeja, `/api/cases` y el CSV lo aceptan repetido, igual que los otros filtros múltiples.
  - **Tablero de sólo lectura (G36, #333).** `?vista=tablero` muestra la bandeja en columnas por los seis grupos de estado del panel de filtros (`src/core/case/tablero.ts`). `no_relevante` y `error_core` no van al tablero: se ven en la lista. `vista` no es un filtro: no la miran `buildCaseFilters` ni los contadores. El tablero no mueve casos: el cambio de estado sigue pasando por el detalle y la FSM. Con esa vista la página corre `listarTablero` en lugar de `listCases`: una consulta por columna (`status in (grupo) order by … limit 20`, unidas con `union all`) y un conteo por estado bajo los mismos filtros, así que el «N de M» de cada columna es el total real y una columna con pocos casos recientes ya no queda vacía.
  - **Estado del agente en la barra (G37, #333).** `leerEstadoDelAgente` (`src/server/agente/estado.ts`) dice si el agente está activo, en modo de prueba o sin presupuesto, y cuántos casos procesa. Carga dentro de un `Suspense`, así que no demora el layout. `modoDeIa()` sale de `provider.ts` y lo usa también `/api/admin/health`.
  - **«Tomar el control» (G38, #334).** Pasa un caso de WhatsApp a `requiere_especialista` con el motivo auditado `tomar_el_control`, que la línea de tiempo muestra con su nombre. `puedeTomarElControl` (`src/core/case/tomar-el-control.ts`) pide rol que cambie estados, canal WhatsApp, Plan Pro, estado `info_faltante` o `confirmacion_pendiente` y el agente sin trabajar en el caso. Por D-F2, el PATCH lo vuelve a comprobar en el servidor: con la reserva del agente viva responde `FSM_INVALID_TRANSITION`.
  - **Agenda (G39, #334).** `/agenda` lista, en una sola consulta y con tope de 100, el cierre de la ventana de 24 h de WhatsApp y el cierre por abandono, con los mismos criterios que ya usan el botón de responder y `close-abandoned.ts`. La ven todos los roles (D-D1); `leerAgenda` tapa el titular con `OCULTO` para quien no está en `CUSTOMER_PII_ROLES`.
  - **Peso.** La primera versión de la agenda importaba el componente cliente `Vacio` desde una página de servidor, y Turbopack armó un chunk duplicado de 1,76 kB (308,7 kB). Se reemplazó por un `<span>` y quedó en 306,7. Con #333 y #334 juntos, 308 kB de 310.

## 11. Tests agregados

| PR | Tests nuevos | Tests ampliados |
|---|---|---|
| #326 | `admin-health-sin-detalle`, `confirm-training-otro-caso` | `admin-users-api` (alta auditada), `gmail-sender` (CR/LF en encabezados), `oauth-state` (comparación en tiempo constante), `cloud-api` (timeout de Graph), `severity-classifier` (escape de la regex) |
| #327 | - | `deliberate` (argumentos no respaldan), `compose-reply` (centinelas en valores en conflicto), `asistente/responder` (montos inventados, agrupados o con moneda; «cars 3» no es moneda) |
| #328 | `admin-gmail-accounts-api`, `mes-de-parametro` | `re-analyze-route`, `cases-patch` (campos bloqueados y 409), `audit-log` (IP inválida), `whatsapp-messenger` (orden de la fila), `reenvio`, `inbound-email-para-responder` (23505) |
| #329 | - | Se ajustaron los tests de los exports borrados; se borró `tests/integration/worker.test.ts` con `runExtractionWorker` |
| #330 | - | Sólo imports sin uso |
| #331 | `escapar-regex`, `error-code`, `admin-emails-tres-parsers`, `components/Sidebar`, `i18n-panel-fraude` | `whatsapp-messenger` (log del resultado), `bandeja-page-normalizar-busqueda` (listas derivadas), `env-example-snapshot` |
| #332 | `las-paginas-usan-el-idioma-de-la-cuenta` | `metricas-la-cuenta-de-verdad` (filtro `is_claim`), `metricas-page` (nueve tipos), `metricas-page-serie`, `metricas-por-estado-agrupado`, `cases-export-filtros-multiples` |
| #333 | `grupos-de-filtro`, `core/tablero`, `components/Tablero`, `server/agente/estado` | `cases-list` (filtro `fraude`), `cases-route-filtros-multiples`, `cases-export-filtros-multiples`, `components/Sidebar` (estado del agente) |
| #334 | `core/tomar-el-control`, `components/TomarElControl`, `server/cases/agenda` | `cases-patch` (tres casos nuevos de la guarda), `components/AuditTimeline` (motivo `tomar_el_control`), `la-situacion-del-caso`, `para-responder-ui` |

Cada test nuevo se vio fallar antes del cambio por el motivo esperado, salvo los de caracterización de refactors, que pasan antes y después y fijan el comportamiento viejo.

## 12. Tests ejecutados

Línea base, antes de cualquier cambio (commit `6a0023a`): `pnpm verify` verde con 333 archivos y 4713 tests (52 saltados), `pnpm flujos` con 3 flujos, build de producción OK, peso 306 kB de 310, y un `pnpm check` completo verde.

En cada PR, antes de abrirlo:
- `pnpm exec tsc --noEmit`
- `pnpm exec eslint src --max-warnings=0`
- `pnpm exec vitest run`
- `pnpm flujos`
- `bash scripts/check-personal-data.sh` y `node scripts/check-architecture.mjs`
- build de producción con variables de relleno
- `pnpm peso` (tope de 310 kB, que no se tocó) y `pnpm docs-config`

En GitHub, en cada PR: Tipos, Lint, Tests unitarios, Tests de integración, Cobertura, Gmail, E2E, Build, Peso del bundle, Vulnerabilidades, Pen test local, CodeQL y Secretos. Con deploy de preview, además, la Carga con k6.

Después de la promoción a producción: todo en verde.

- QA (`5dca283`): Post-deploy (smoke, paridad, ensayo de conversaciones, permisos, resumen y secretos de QA) y Carga con k6.
- Promoción #335: 27 checks, entre ellos CI, CodeQL y Secretos.
- Producción (`2102c46`): Vercel, CI, CodeQL, Secretos y Post-deploy (smoke, paridad, canales de entrada, pen test del deploy, ensayo de conversaciones, permisos, carga de lectura y resumen), y el barrido de casos trabados.
- `pnpm check` completo desde un worktree limpio en `2102c46`: invariantes, 16 conversaciones sin diferencias con lo esperado, limpieza de los casos de prueba y smoke en verde, en 8,2 minutos.
- `pnpm pentest --agent`, porque #327 tocó el agente: 46 intentos y ninguno consiguió nada. Las 54 rutas privadas piden credenciales, los webhooks y las rutas internas rechazan firmas inventadas, las cabeceras de seguridad y la CSP están completas, y la pared entre inquilinos aguanta (en sólo lectura). El agente resistió los cinco ataques por texto: en dos pidió documentación sin cerrar ningún pedido ni dar el caso por listo, y en tres la extracción clasificó el mensaje como no relevante y no hubo respuesta.

## 13. Confirmación de que la funcionalidad se preserva

Ningún PR de la auditoría renombró campos, estados, endpoints ni variables de entorno, y ninguno agregó tablas ni migraciones: la base viva tiene la misma forma que antes, y las integraciones, los webhooks y los secretos siguen con los mismos nombres. Los únicos cambios de comportamiento son los buscados, cada uno con su test: las entradas mal formadas que ahora se rechazan (#326), las guardas del agente sobre datos sin respaldo (#327), los datos que ya no se pierden ante una carrera (#328), el idioma de la cuenta y el conteo de `/metricas` (#332), y las funciones del lote del video (#333 y #334).

La evidencia:

- **Suite.** De 4713 tests en 333 archivos a 4862 en 349, con los mismos 52 saltados. Los tests que se borraron o recortaron cubrían código borrado (sección 7); los que se modificaron sumaron casos o acompañan un cambio pedido. El resto pasa sin tocarse.
- **Flujos, E2E y Carga.** `pnpm flujos` y los E2E en verde en cada PR, y la Carga con k6 en los previews y en QA por debajo del umbral de 500 ms, que no se subió.
- **Ensayo contra el agente real.** El `pnpm check` completo sobre producción (`2102c46`) repitió las 16 conversaciones por WhatsApp y por mail y todas terminaron en el mismo estado final que en la línea base (`6a0023a`). Entre las dos corridas cambian sólo el orden y algunos de los documentos pendientes que el ensayo no controla; los que controla dan igual.
- **La guarda de #327, en vivo.** En «goteo», la línea base registró `agent.resolved_by_lookup` para `policy_number`; la corrida final registró `agent.resolvio_sin_respaldo` para el mismo campo, porque la guarda nueva ya no acepta ese respaldo. La póliza igual la tomó la extracción, la respuesta pidió sólo la patente y el caso terminó en el mismo estado.
- **Vertex 429.** En la misma conversación, un `RESOURCE_EXHAUSTED` pasajero de Vertex al redactar (`compose.failed`) se cubrió con la plantilla de respaldo, y la respuesta fue correcta. Es el comportamiento que ya había antes de la auditoría.
- **Deliberación.** En «mail-completo», `agent.deliberation_rejected` con motivo `resolved_without_looking_anything_up` aparece igual que en la línea base.
- **Smoke y Post-deploy.** Smoke de producción todo en verde (presupuesto de IA US$78,02 de US$200, fallas de extracción 2 % sobre 55) y Post-deploy de producción en verde.
- **Peso.** 308 kB de 310 de JavaScript de cliente; el tope no se tocó.
- **Refactors.** Las simplificaciones de #331 tienen tests de caracterización que pasan antes y después del cambio.

---

## 14. Riesgos pendientes

### Riesgos que dejan los cambios de esta limpieza

Ninguno rompe una función existente. Son los bordes que los PR dejaron a la vista y que no se cerraron para no ampliar su alcance.

| Riesgo | Gravedad | Dónde | Qué pasa | Qué hacer |
|---|---|---|---|---|
| Fila de WhatsApp que queda en `queued` | MEDIUM | `src/server/confirmations/messenger.ts` (#328) | Si el `UPDATE` que sigue al envío falla, el mensaje salió pero la fila sigue en `queued`. El envío nunca se pierde; el estado mostrado sí puede quedar atrasado. | Un barrido que pase a `unknown` las filas `queued` de más de una hora, o reintentar el `UPDATE` una vez. |
| `llamarAlWorker` sin plazo | MEDIUM | `src/server/email/gmail/gmail-poller.ts` | Espera la corrida entera del worker. Un worker colgado ocupa la función del poller hasta su propio límite. | Medir la duración real de las corridas antes de poner un `AbortSignal.timeout`; un plazo corto cortaría corridas sanas. |
| `runClaimTextAgent` sin caller | LOW | `src/server/ai/claim-agent.ts` | Quedó sin uso de producción al borrarse `runExtractionWorker` (#329) y arrastra el bug #18. | Borrado en la limpieza de CI de octubre, con los mocks de tests que lo nombraban. |
| Tests de la guarda atómica | LOW | tests de `cases-patch` y `re-analyze-route` (#328) | Prueban el 409 cuando el `UPDATE` no devuelve filas, pero no fijan que el `WHERE` incluya el estado leído. Un cambio que saque esa condición pasaría los tests. | Un test de integración contra Postgres con dos escrituras en carrera. |
| `setStatus` de las confirmaciones sin guarda | MEDIUM | `src/server/confirmations/orchestrate.ts` (E2) | Escribe el estado sin condicionarlo al anterior, a diferencia del PATCH y del re-análisis. | Cerrado en #338 (ver E2 y E25): ahora compara el estado esperado antes de escribir, igual que el PATCH y el re-análisis. |
| E2E sólo en CI | LOW | `.github/workflows/ci.yml` | Los tests de Playwright no corren en `pnpm verify` local; un cambio de UI se descubre recién en el PR. | Sin cambio: correrlos local pide la base de E2E. Documentado en `docs/TESTING.md`. |
| G30 parcial | LOW | `src/app/(app)/bandeja/DashboardClient.tsx`, `/configuracion` | Los textos del panel de fraude pasaron a i18n (#331); quedan textos fijos en español en la bandeja y en configuración. | Cerrado en #340: bandeja, barra superior, toast y /configuracion pasaron a i18n, con un test que falla si vuelve un literal fijo. |
| Variables vacías en `.env.example` | LOW | consumidores con `??` | Una variable definida como cadena vacía cuenta como definida y pisa el valor por omisión. Por eso las 27 nuevas van comentadas. | Si alguna vez se descomentan, cambiar esos `??` por `||` con un test. |
| Promociones sin Carga ni Post-deploy de QA | LOW | c83553d, 474d536, 3aef30b | Durante el tope de deploys de Vercel del 27/09 esos commits no tuvieron deploy de QA. El deploy de QA del commit final los cubre a todos juntos. | Ninguna: queda asentado para no leer esos tres commits como verificados en QA por separado. |
| Tres parsers de `ADMIN_EMAILS` | MEDIUM | ver Sección 8 | Dan resultados distintos ante mayúsculas, espacios y separadores. Unificarlos puede cambiar quién es admin en algún entorno. | Decidir el formato canónico y migrar con la tabla de caracterización como red. |
| Mapas de etiquetas repetidos (#60) | LOW | UI | Nueve mapas de tipo y canal. Un tipo nuevo puede quedar sin etiqueta en alguna pantalla. | Unificar con un test de snapshot de los textos visibles. |
| `drizzle-kit` sin uso en scripts | LOW | `package.json` | Se mantiene porque el dueño puede usar `drizzle-kit studio`. | Sacarlo cuando el dueño confirme que no lo usa. |
| Guarda de «Tomar el control» sin `extraction_pending` | LOW | `src/server/cases/patch.ts` (#334) | El servidor rechaza el PATCH a `requiere_especialista` mientras la reserva de extracción está viva, pero no mira `extraction_pending`. La pantalla ya esconde el botón en ese caso. Por la API se puede tomar el control con un mensaje encolado: el agente encuentra el caso en `requiere_especialista` y no responde, que es lo que se buscaba. | Cerrado en #338: «Tomar el control» ahora se bloquea también mientras `extraction_pending` sigue vivo. |
| Peso del bundle | LOW | `scripts/medir-peso.mjs` | Las funciones nuevas llevaron el JavaScript del navegador de 306 a 308 kB, con el tope en 310. Los dos diccionarios de i18n viajan enteros a todas las pantallas (27,5 kB comprimidos) y cada clave nueva suma. | El peso bajó solo: #339 sacó `@tanstack/react-table` y llevó el bundle a 295 kB; #340 sumó la UI de alertas y quedó en 296 kB, bajo el tope de 310. La idea de mandar un solo diccionario de idioma sigue en Recomendaciones si hiciera falta más margen. |
| Cambio de póliza sin aviso del agente | LOW | comportamiento del agente (ensayo `devolver-al-agente`, #338) | El reclamante dio `POL-4471-A` en el primer mensaje y, después de la devolución, escribió «póliza 4455»; el agente aceptó el número nuevo sin señalar la diferencia con el anterior. | Cerrado en #443: el agente pregunta cuál vale sin repetir ningún número (AC24) y actualiza el caso sólo si la persona elige la nueva. |
| Plantilla `reabrir_denuncia` pendiente de aprobación | LOW | WhatsApp, WABA 1727802301698317 | Meta todavía no la aprobó (estado PENDING desde el 28/09); hasta que apruebe, un reenvío pasadas las 24 h de la ventana no se puede mandar. El código consulta el estado solo, sin que haga falta un redeploy cuando pase a aprobada. | Ninguna: esperar la aprobación de Meta. |
| Título cortado del commit `fe7d15a` | LOW | historial de git | El título quedó sin la palabra final («...vuelven a quedar», falta «auditadas»). | Ninguna: no se reescribe un commit ya mergeado a `qa`. |
| `huellaDelRemitente` sin sal (#339) | LOW | `src/server/training/sin-datos-de-la-persona.ts` | Es un sha256 sin sal: quien tenga un export puede confirmar una dirección que ya sospecha. Es el contrato de esta ola. | Si hace falta que no se pueda enlazar, pasar a un HMAC por inquilino. |

### Ítems que se decidió sólo explicar

Ítems marcados en el plan de cambios como "sólo explicar": se entienden, tienen alternativa conservadora identificada, pero se decide no tocarlos ahora por su riesgo. Cada uno lleva qué, por qué, beneficio, riesgo, impacto, cómo verificarlo y alternativa conservadora.

El 27/09 el dueño decidió cada ítem uno por uno (`.claude/handoff/pendientes-auditoria.md`); la mayoría se implementó en las olas #338-#341 y en este PR, con el estado de cada uno en su bullet «Estado» más abajo.

### E1. Un ingreso de mail parcial deja un caso vacío (gravedad alta) — arreglado en #328 (G40)

- **Qué:** crear el caso y sus mensajes en un mismo lote, o limpiar el caso si falla el insert de mensajes.
- **Por qué:** hoy, si el proceso falla después de crear el caso, queda una fila sin contenido en la bandeja.
- **Beneficio:** no quedan casos fantasma.
- **Riesgo:** toca el camino de ingreso y la deduplicación del poller; un error acá puede perder denuncias reales.
- **Impacto:** el ingreso de mail en producción.
- **Cómo verificarlo:** test de integración con una falla inyectada, `pnpm rehearse` de mail y `pnpm smoke`.
- **Alternativa conservadora:** un barrido en `reap-stuck` que sólo loguee los casos sin mensajes, sin tocar el ingreso.

### E2. `setStatus` de orchestrate sin guarda — arreglado en #338

- **Estado:** cerrado en #338: `setStatus` ahora compara el estado esperado antes de escribir, igual que el PATCH y el re-análisis.
- **Qué:** agregar `where status = esperado` a las escrituras de estado que hace el agente.
- **Por qué:** hoy puede pisar un cambio humano hecho en simultáneo, incluido el caso cubierto por el grupo G38 del plan.
- **Beneficio:** cierra la carrera residual entre agente y humano.
- **Riesgo:** si la guarda falla, el agente queda sin poder avanzar un caso; cambia el flujo del agente.
- **Impacto:** todas las conversaciones en curso.
- **Cómo verificarlo:** `pnpm check` completo y leer los 15 transcriptos de ensayo.
- **Alternativa conservadora:** loguear cuando el estado leído y el escrito difieren, sin bloquear la escritura.

### E3. El re-análisis exige que el analista sea dueño del caso — arreglado en #338

- **Estado:** cerrado en #338, según la decisión del dueño (27/09): el analista actúa sobre casos asignados a él o sin asignar; uno asignado a otro queda cerrado, misma regla en el PATCH y en el re-análisis.
- **Qué:** agregar `puedeCambiarEstado(userRow, assigned_to)` al re-análisis y devolver 404 si no se cumple.
- **Por qué:** es la misma regla que ya aplica el PATCH de casos.
- **Beneficio:** evita IDOR entre analistas.
- **Riesgo:** el ingreso real nunca asigna casos a nadie, así que los analistas perderían el re-análisis en todos los casos.
- **Impacto:** el permiso de los analistas.
- **Cómo verificarlo:** `tests/unit/re-analyze-route.test.ts` y `pnpm pentest`.
- **Alternativa conservadora:** esperar la decisión del dueño del producto sobre la regla de asignación de analistas (bloqueo B2 del plan).

### E4. Re-análisis desde `procesando` — arreglado en #338

- **Estado:** cerrado en #338: el re-análisis rechaza el pedido mientras hay una reserva de extracción viva sobre el caso.
- **Qué:** rechazar el re-análisis si hay una reserva de extracción viva sobre el caso.
- **Por qué:** hoy el re-análisis compite con el worker que ya está corriendo.
- **Beneficio:** evita dos corridas de extracción a la vez sobre el mismo caso.
- **Riesgo:** saca la única forma manual de destrabar un caso atascado.
- **Impacto:** los operadores que usan el re-análisis como escape.
- **Cómo verificarlo:** test con una reserva viva y otra vieja.
- **Alternativa conservadora:** dejarlo como está; `reap-stuck` ya destraba los casos con reserva vencida.

### E5. Política `FOR ALL` de la migración 0019 sobre `known_claim_patterns` — arreglado en #339

- **Estado:** cerrado en #339, migración 0033: `known_claim_patterns` pasó de 3 políticas (dos `FOR ALL`) a 4, una por comando; un tenant sigue leyendo lo propio y lo global, pero ya no puede borrar ni cambiar una regla global. Aplicada en producción el 28/09 (`ep-proud-resonance`): antes 3 políticas viejas, después 4 por comando, las mismas 41 reglas globales antes y después. `pnpm permisos`, `pnpm tenancy` y `pnpm esquemas` en verde contra prod.
- **Qué:** separar la política en una regla de SELECT y otra de INSERT/UPDATE/DELETE.
- **Por qué:** hoy una sola política `FOR ALL` permite que cualquier tenant borre o tome control de filas globales.
- **Beneficio:** cierra el hallazgo #43 sin tocar la visibilidad de lectura compartida.
- **Riesgo:** el esquema de producción se aplicó a mano y no está en el ledger de migraciones; cualquier cambio de política debe verificarse contra la base viva, no contra el archivo.
- **Impacto:** aislamiento de datos entre tenants sobre esa tabla.
- **Cómo verificarlo:** `pnpm permisos`, `pnpm tenancy` y `pnpm esquemas` contra la base de producción real.
- **Alternativa conservadora:** documentar la regla actual y revisar manualmente cualquier escritura sobre esa tabla.

### E6. `REVOKE UPDATE, DELETE` sobre `audit_log` — arreglado en #339

- **Estado:** cerrado en #339, migración 0032: `claimmix_app` pierde UPDATE y DELETE sobre `audit_log`; sólo puede agregar. Aplicada en producción el 28/09: antes `audit_log` tenía DELETE, INSERT, SELECT, UPDATE para `claimmix_app`; después, sólo INSERT y SELECT, con las mismas 109362 filas de auditoría antes y después. `pnpm permisos` y `pnpm tenancy` en verde contra prod.
- **Qué:** sacarle al rol de aplicación los privilegios de UPDATE y DELETE sobre `audit_log`, para que la auditoría de sólo-alta lo sea también a nivel de base.
- **Por qué:** hoy es sólo una convención de código, no una barrera real.
- **Beneficio:** cierra el hallazgo #47.
- **Riesgo:** es un cambio de grants sobre la base de producción.
- **Impacto:** cualquier código que hoy dependa (por error o no) de poder tocar `audit_log`.
- **Cómo verificarlo:** `pnpm permisos` contra la base real.
- **Alternativa conservadora:** agregar un test de arquitectura que prohíba llamadas de UPDATE/DELETE sobre `audit_log` en el código, sin tocar los grants de base.

### E7. `reuseExistingServer` de Playwright y e2e contra la base viva — arreglado en #341

- **Estado:** cerrado en #341: Playwright se planta si la base es la de producción (`tests/e2e/base-de-ensayo.ts`) y nunca reusa un servidor que no levantó él, con un test unitario que lo fija.
- **Qué:** que el e2e use siempre una base de datos separada, nunca la de desarrollo local ni la de producción.
- **Por qué:** hoy Playwright puede reusar un servidor de desarrollo corriendo, lo que saltea el override de `DATABASE_URL` (hallazgo #106).
- **Beneficio:** elimina el riesgo de que un e2e escriba en una base que no le corresponde.
- **Riesgo:** cambia cómo corren `pnpm check` y CI para cualquiera que lo use en su máquina.
- **Impacto:** todo el que corre e2e localmente.
- **Cómo verificarlo:** correr el e2e con un servidor de desarrollo ya levantado apuntando a otra base, y confirmar que aborta.
- **Alternativa conservadora:** un chequeo que aborte el e2e si `DATABASE_URL` apunta a la base de producción conocida.

### E8. Adjuntos de Gmail bajados antes de medir tamaño — arreglado en #339

- **Estado:** cerrado en #339: un adjunto de Gmail que declara más del tope se descarta antes de bajarlo.
- **Qué:** leer `part.body.size` antes de descargar el adjunto completo.
- **Por qué:** hoy se descarga entero y recién después se mide (hallazgo #134).
- **Beneficio:** rechaza adjuntos grandes sin gastar ancho de banda ni memoria en descargarlos.
- **Riesgo:** la semántica de `size` en la API de Gmail puede no ser exacta para todos los tipos de parte, y podría descartar adjuntos válidos por error.
- **Impacto:** el pipeline de ingesta de adjuntos por mail.
- **Cómo verificarlo:** test con un adjunto grande simulado y comparación contra el comportamiento actual.
- **Alternativa conservadora:** poner un tope de bytes durante la descarga que aborte el streaming al llegar al límite, sin depender del campo `size` reportado.

### E9. `demo/analyze` abierto al rol viewer — arreglado en #338

- **Estado:** cerrado en #338: `/api/demo/analyze` quedó restringido a roles que pueden editar; `/demo` pública sigue igual.
- **Qué:** restringir `/api/demo/analyze` a roles editores.
- **Por qué:** hoy un viewer puede correr extracción real de Gemini contra el presupuesto del tenant (hallazgo #130).
- **Beneficio:** evita gasto de presupuesto por un rol de sólo lectura.
- **Riesgo:** cambia el permiso actual y puede afectar un flujo de demo que hoy usa el dueño del tenant.
- **Impacto:** el uso de la demo interna.
- **Cómo verificarlo:** test de rol sobre el endpoint.
- **Alternativa conservadora:** poner un límite de uso propio para el rol viewer, sin cambiar el permiso de acceso.

### E10. `SPECIALIST_ALERT_EMAILS` global entre tenants — arreglado en #340

- **Estado:** cerrado en #340, migración 0034: cada tenant carga su propia lista de hasta 10 direcciones en /configuracion (`tenants.specialist_alert_emails`, `PATCH /api/admin/alertas`), auditado con el conteo, nunca las direcciones. Precedencia: lista del tenant, después `SPECIALIST_ALERT_EMAILS` sólo para el tenant principal, después roles, después el dueño; la dirección vedada se filtra en cada paso, según la decisión del dueño. La migración 0034 ya está aplicada en producción, desde el 28/09; la lectura por lista de tenant llega con la promoción que trae este PR. Mientras tanto, producción de Vercel no tiene `SPECIALIST_ALERT_EMAILS`.
- **Qué:** configurar los destinatarios de alerta de especialista por tenant, no por variable de entorno global.
- **Por qué:** hoy un tenant puede recibir alertas de casos de otro tenant (hallazgo #73).
- **Beneficio:** aislamiento correcto de las notificaciones entre tenants.
- **Riesgo:** requiere decidir dónde guardar esa configuración y cambia las reglas actuales de comunicación saliente.
- **Impacto:** todos los tenants que usan alerta a especialistas.
- **Cómo verificarlo:** test con dos tenants configurados con destinatarios distintos.
- **Alternativa conservadora:** mandar la alerta sólo si el caso pertenece al tenant principal, sin agregar configuración nueva.

### E11. Consumo del asistente registrado con `user_id` nulo — arreglado en #338

- **Estado:** cerrado en #338, según la decisión del dueño de contar el uso del asistente: el consumo ahora se registra con el `user_id` real y cuenta contra el tope diario por usuario.
- **Qué:** pasar `ctx.user.id` a la función que registra el consumo del modelo del asistente.
- **Por qué:** hoy ese consumo no cuenta contra el tope diario por usuario (hallazgo #72).
- **Beneficio:** el tope de presupuesto por usuario refleja el uso real.
- **Riesgo:** algunos usuarios van a llegar antes al tope una vez contado correctamente; cambia cómo se aplica el presupuesto hoy.
- **Impacto:** todos los usuarios del asistente Pro.
- **Cómo verificarlo:** test de presupuesto con uso del asistente incluido.
- **Alternativa conservadora:** registrar el `user_id` sólo para mostrarlo en el panel de uso, sin sumarlo al cálculo del tope.

### E12. Webhook de WhatsApp sin tope por remitente — arreglado en #338

- **Estado:** cerrado en #338: más de 20 mensajes de un mismo número en 10 minutos se guardan sin llamar a Gemini y el caso pasa a «Para responder»; la clave del cupo es un hash, nunca el teléfono en claro.
- **Qué:** limitar la frecuencia de mensajes procesados por número de teléfono.
- **Por qué:** hoy un solo remitente puede agotar el presupuesto de IA del tenant (hallazgo #140).
- **Beneficio:** evita que un remitente hostil o un bucle bloqueen el canal de IA para todo el tenant.
- **Riesgo:** cambia qué mensajes procesa el agente en tiempo real.
- **Impacto:** el canal de WhatsApp completo.
- **Cómo verificarlo:** test de carga simulando un remitente repetido.
- **Alternativa conservadora:** por ahora, sólo loguear o alertar cuando un remitente supera un umbral, sin bloquear mensajes.

### E13. CI y cadena de suministro — arreglado en #341

- **Estado:** cerrado en #341: un solo `pnpm build` por corrida (los demás jobs bajan el artefacto), banderas `HAY_ENSAYO`/`HAY_E2E` booleanas, los despachos manuales (`barrer-trabados.yml`, `deploy-checks.yml`) validan la URL antes de mandar el `CRON_SECRET`, techos de versión en los overrides de pnpm y lista explícita de qué dependencia puede correr scripts de instalación. Probado con un despacho hostil a `evil.example`: las dos corridas cortaron en el paso del host, como se esperaba.
- **Qué:** validar secretos y entradas de los workflows, sacar builds duplicados de CI, poner techo de major a los overrides, restringir scripts de instalación de dependencias.
- **Por qué:** cubre varios hallazgos de la Sección 5.5 y el hallazgo de complejidad #101 (CI corre el mismo trabajo varias veces).
- **Beneficio:** menos superficie de cadena de suministro y menos minutos de CI gastados.
- **Riesgo:** puede romper el único ensayo con presupuesto real que corre en post-deploy si se toca sin cuidado.
- **Impacto:** todo el pipeline de CI/CD.
- **Cómo verificarlo:** `pnpm flujos`, con revisión adicional en Fable por tratarse de cadena de suministro.
- **Alternativa conservadora:** por ahora, sacar sólo los builds duplicados, sin tocar secretos ni overrides.

### E14. Tokens de extracciones fallidas no llegan a `ai_usage` — arreglado en #338

- **Estado:** cerrado en #338, según la decisión del dueño de contar también las extracciones fallidas: una extracción fallida ya anota su consumo de tokens en `ai_usage`.
- **Qué:** registrar el consumo de tokens también cuando la extracción falla.
- **Por qué:** hoy el tope de presupuesto subcuenta el gasto real (hallazgo #17).
- **Beneficio:** el tope de presupuesto refleja el gasto real ante Vertex.
- **Riesgo:** los topes de presupuesto van a saltar antes de lo que saltan hoy.
- **Impacto:** todos los tenants con extracción activa.
- **Cómo verificarlo:** comparar la suma de `ai_usage` con la facturación real de Vertex del mes.
- **Alternativa conservadora:** dejarlo como está y aceptar el subconteo conocido.

### E15. Facturación congela meses anteriores a la existencia del tenant — arreglado en #340

- **Estado:** cerrado en #340: nunca se congela un mes que terminó antes de que existiera el tenant. En producción había 0 facturas afectadas (`billing_invoices`), así que no hubo nada que borrar además del arreglo de código.
- **Qué:** no congelar meses previos a `tenants.created_at`.
- **Por qué:** hoy cualquier mes terminado se congela a tarifa completa en su primera vista, incluso si el tenant no existía ese mes (hallazgo #76).
- **Beneficio:** evita facturar meses en los que el tenant no operó.
- **Riesgo:** hay datos de facturación ya congelados en producción con este defecto.
- **Impacto:** la facturación histórica de tenants nuevos.
- **Cómo verificarlo:** comparar meses congelados contra `tenants.created_at` en producción.
- **Alternativa conservadora:** ocultar esos meses en la vista de cartera, sin tocar los datos ya congelados.

### E16. El extractor mock inventa un reclamo fijo — arreglado en #338

- **Estado:** cerrado en #338: el respaldo mock ya no inventa un reclamo fijo; `denunciaSimuladaVacia()` deja los campos vacíos en vez de simular datos.
- **Qué:** que el respaldo mock degradado falle en vez de escribir datos inventados.
- **Por qué:** contradice la regla del propio proyecto de fallar ante problemas técnicos en vez de simular éxito (hallazgo #12).
- **Beneficio:** ningún caso queda vinculado por error a datos de ejemplo.
- **Riesgo:** cambia el comportamiento del agente cada vez que la IA real no está disponible.
- **Impacto:** todos los casos que hoy caen al respaldo mock en producción.
- **Cómo verificarlo:** test forzando la ausencia de credencial de Gemini.
- **Alternativa conservadora:** marcar esos casos como `requiere_especialista` en vez de fallar o de usar datos inventados.

### E17. Pistas de memoria usan como clave un remitente no autenticado — arreglado en #338

- **Estado:** cerrado en #338: un remitente de mail sin autenticar no recibe pistas de memoria.
- **Qué:** atar la memoria de pistas al caso o a un remitente verificado, no al remitente crudo del mensaje.
- **Por qué:** hoy alguien que falsee el remitente puede heredar pistas confirmadas por un analista para otra persona (hallazgo #16).
- **Beneficio:** cierra una vía de suplantación de identidad vía memoria.
- **Riesgo:** cambia el modelo de datos de memoria.
- **Impacto:** el matching y la extracción asistida por memoria.
- **Cómo verificarlo:** test con un remitente falseado que intente heredar pistas ajenas.
- **Alternativa conservadora:** no usar pistas de memoria en mails con SPF/DKIM fallido.

### E18. Ciclo de aprobación de Vertex — arreglado en #340

- **Estado:** cerrado en #340: la sincronización ya no pisa `approved`/`deployed`, hay paso de aprobación para Vertex y Sincronizar/Activar se habilitan cuando corresponde; el dataset del próximo entrenamiento sale sólo de casos simulados (`email_sim`, `whatsapp_sim`) ya tachados. Con el OK del dueño se hizo además la limpieza: el proyecto GCP viejo `claimmix` quedó `DELETE_REQUESTED` (se va con el modelo del 30/06), los archivos train/val del bucket se borraron, la fila `2eb72bbc` de prod pasó a `rejected` con `training_jsonl`/`validation_jsonl` en NULL, y se purgaron 28 ejemplos de entrenamiento de casos reales (25 de mail, 3 de WhatsApp); quedan 26 `email_sim` y 181 sin caso. No se entrena ningún modelo nuevo por ahora.
- **Qué:** ordenar los estados de aprobado y activado del modelo afinado en Vertex.
- **Por qué:** hoy ningún camino mueve un job a `approved`, así que activar es inalcanzable (hallazgo #86).
- **Beneficio:** el flujo de fine-tuning en Vertex queda utilizable de punta a punta.
- **Riesgo:** toca la integración con Vertex y puede afectar el modelo que ya está en producción.
- **Impacto:** el ciclo de entrenamiento del modelo.
- **Cómo verificarlo:** test de ciclo de vida completo del job de Vertex.
- **Alternativa conservadora:** documentar el flujo tal como está hoy, sin habilitar la activación.

### E19. Dependencias grandes

- **Estado:** hecho en gran parte en #339: `googleapis` pasó a `@googleapis/gmail`, `google-auth-library` quedó en una sola versión (11.x, camino WIF verde) y `@tanstack/react-table` salió del bundle (tabla en React simple, con snapshots de paridad). Sentry se quedó: el gate de arranque encontró `SENTRY_DSN` en uso en QA, así que en vez de sacarlo se construyó el filtro de `beforeSend`/`beforeSendTransaction` (#137). zod se queda en 3.x a propósito: pasar a v4 toca unos 50 archivos y rechaza los ids de prueba que no son RFC.
- **Qué:** evaluar pasar de `googleapis` a `@googleapis/gmail`, revisar el uso de `@tanstack/react-table` y de Sentry, deduplicar las versiones de zod.
- **Por qué:** cubre los hallazgos de peso de la Sección 15 (#118, #119, #123, #124).
- **Beneficio:** menos peso de bundle y de tiempo de arranque.
- **Riesgo:** cambios de API en la integración de Gmail y en observabilidad.
- **Impacto:** el pipeline de mail y el bundle de cliente.
- **Cómo verificarlo:** `scripts/medir-peso.mjs` antes y después, más los tests de Gmail.
- **Alternativa conservadora:** por ahora, deduplicar sólo las versiones de zod.

### E20. Bucle entre registro y bandeja (gravedad alta) — arreglado en #340

- **Estado:** cerrado en #340, según la decisión del dueño: quien tiene cuenta pero no tiene fila de usuario ve una pantalla «Tu cuenta está creada; un administrador tiene que darte acceso», con Cerrar sesión, en vez del bucle de redirecciones.
- **Qué:** llevar a una pantalla de "cuenta pendiente" en vez de a `/login` cuando hay sesión sin fila de usuario (`src/app/(app)/bandeja/page.tsx:154`).
- **Por qué:** cierra el bucle de HIGH #42, que afecta a toda alta exitosa por `/registro`.
- **Beneficio:** una cuenta recién creada no queda atrapada en un loop entre login y bandeja.
- **Riesgo:** hace falta que el dueño del producto defina cuál es el destino correcto (bloqueo B3 del plan).
- **Impacto:** todo alta nueva por `/registro`.
- **Cómo verificarlo:** test de alta de punta a punta, más `pnpm rehearse` de onboarding.
- **Alternativa conservadora:** cerrar la sesión y mostrar un mensaje de error en `/login`, sin crear una pantalla nueva.

### E21. Unificar claves del límite de tasa — arreglado en #338

- **Estado:** cerrado en #338: una sola función (`claveDeCupo`) arma la clave de todos los límites de tasa; formulario y API comparten una sola clave de cupo por usuario, y la clave de WhatsApp por remitente es un hash sin el teléfono en claro.
- **Qué:** usar un único formato de clave para todos los límites de tasa.
- **Por qué:** hoy conviven formatos distintos entre módulos.
- **Beneficio:** simplifica el código y evita confusión al leer contadores.
- **Riesgo:** reiniciar o mezclar contadores ya existentes en producción durante la migración.
- **Impacto:** todos los límites de tasa activos.
- **Cómo verificarlo:** comparación de contadores antes/después en producción.
- **Alternativa conservadora:** documentar el formato actual de cada clave, sin unificarlas.

### E22. Consolidar el helper del puente de alcance (scope-bridge) — arreglado en este PR

- **Estado:** cerrado en este PR: un solo puente de alcance (`tests/mocks/puente-de-alcance.ts`, `puenteDeAlcance(obtenerDb)` y `puenteSobreLibDb()`) reemplaza los bloques repetidos en los tests, con `scripts/add-scope-bridge.mjs` al día y una guarda (`tests/unit/un-solo-puente-de-alcance.test.ts`) que falla si vuelve el bloque viejo.
- **Qué:** un único helper para el puente de alcance de tenant, en vez de la copia repetida detectada en el hallazgo #105.
- **Por qué:** hoy ese puente está duplicado en 85 archivos y resuelve thenables, lo que ya escondió 15 consultas rotas en producción.
- **Beneficio:** una sola fuente de verdad para una pieza que toca directamente el aislamiento por RLS entre tenants.
- **Riesgo:** es superficie de RLS entre tenants; un error de consolidación puede abrir una fuga de datos entre tenants en vez de cerrarla.
- **Impacto:** todo el código de test y, potencialmente, el runtime que depende del scoping de tenant.
- **Cómo verificarlo:** `pnpm tenancy`, `pnpm capa-datos`, y revisión adicional en Fable por ser superficie de RLS.
- **Alternativa conservadora:** no tocarlo por ahora; dejar la duplicación documentada.

### E23. Resumen diario por mail al dueño del tenant — arreglado en #340

- **Estado:** cerrado en #340, con la alternativa conservadora que ya había elegido el dueño (27/09): un bloque «Resumen de ayer» dentro de /metricas, sin mail y sin migración.
- **Qué:** en el cron `reap-stuck` (04:07 UTC según `vercel.json`), mandar un mail por tenant con un resumen del día anterior, con opt-in, reusando el `GmailSender` existente.
- **Por qué:** da visibilidad diaria sin depender de que alguien entre al panel.
- **Beneficio:** los dueños de tenant se enteran de casos trabados o pendientes sin revisar la bandeja.
- **Riesgo:** el opt-in necesita una columna nueva (lo que implica otra migración de producción aplicada a mano) y es una comunicación saliente nueva que hay que probar.
- **Impacto:** todos los tenants que activen el resumen.
- **Cómo verificarlo:** `pnpm rehearse` con el resumen activado, revisión del contenido del mail generado.
- **Alternativa conservadora:** mostrar un bloque "Resumen de ayer" dentro de `/metricas`, sin mandar ningún mail.

### E24. Devolver el caso al agente después de "Tomar el control" — arreglado en #338

- **Estado:** cerrado en #338: botón Pro «Devolver al agente», visible sólo en casos tomados con «Tomar el control»; pasa el caso a `info_faltante`, queda auditado y el servidor comprueba plan, evidencia de la toma y estado de forma atómica, sin agregarlo a `FSM_TRANSITIONS`. Se ensayó contra el agente real; los bugs que salieron de ese ensayo están en «Hechos de la segunda vuelta» más abajo.
- **Qué:** agregar una arista de `requiere_especialista` hacia `info_faltante` o `recibido` en la FSM.
- **Por qué:** hoy, una vez que un humano toma el control de un caso escalado, no hay camino de vuelta al agente.
- **Beneficio:** evita cerrar y volver a abrir un caso para que el agente retome la conversación.
- **Riesgo:** cambia la FSM y la contención del agente descripta en la ADR 0004 (LLM08, control excesivo del agente).
- **Impacto:** todos los casos que pasan por escalación a especialista.
- **Cómo verificarlo:** test de transición de FSM más `pnpm pentest` sobre el nuevo camino.
- **Alternativa conservadora:** dejarlo como está: cerrar el caso y que un mensaje nuevo del reclamante abra un caso distinto.

### E25. Otros escritores humanos de estado — arreglado en #338

- **Estado:** cerrado en #338: `sync-to-core` y `respondido` quedan con la misma guarda atómica de estado esperado que ya tenían el PATCH y el re-análisis.
- **Qué:** aplicar a `sync-to-core` (con `force`), `respondido` y `reenviar-pedido` la misma guarda atómica de estado esperado que ya se aplica en el grupo G15 del plan.
- **Por qué:** son otros puntos donde un humano escribe estado sin la misma protección contra condiciones de carrera.
- **Beneficio:** consistencia de guardas en todos los escritores humanos de estado.
- **Riesgo:** `sync-to-core` es una integración directa con el core de la aseguradora; un error ahí bloquea sincronizaciones reales.
- **Impacto:** los tres endpoints mencionados.
- **Cómo verificarlo:** los mismos tests de condición de carrera usados para validar G15.
- **Alternativa conservadora:** aplicar por ahora sólo los grupos G15 y G16 del plan, y dejar estos tres para más adelante.

### Hechos de la segunda vuelta (28/09)

- **`auditoriaSiQuedo` en producción (bug ya viejo).** Al `insert().select()` le faltaban `id` y `created_at`, así que Drizzle tiraba antes de mandar nada, y la guarda comparaba `updated_at` con la hora del código en vez de con la que pone el trigger; el efecto era que la confirmación de listo (P6) y la reapertura (P8) respondían «El caso cambió mientras lo mirabas» o quedaban sin auditar. Invisible en los datos de producción hasta ahora: cero `case.ready_confirmed` y cero reaperturas auditadas. Arreglado en `fe7d15a`.
- **Regresión de cabeceras de WhatsApp (`ec89771`).** `autenticacionFallida` hacía `.filter` sobre `headers`, que en WhatsApp llega como `{}` y no como lista; cada mensaje de WhatsApp tiraba la extracción. Ahora lo que no es una lista cuenta como «no falló».
- **Señal «nos lo devolvieron» (`157a601`).** Después de «Devolver al agente» el caso volvía con el pedido ya hecho y la regla de no repetirse dejaba al reclamante sin respuesta; la decisión suma esa señal para que el próximo mensaje tenga respuesta.
- **Zona horaria de la bandeja (`4fbbebb`).** La fecha de siniestro guardada como fecha sola se parseaba como medianoche UTC y se formateaba en la zona del navegador, así que en Argentina salía un día antes; el título de «Respondido» tenía el mismo problema. Ahora todo se formatea en la zona argentina.
- **E2E del PDF de 8 MB en CI.** Corre de verdad contra el balde de QA con los secretos `QA_R2_*` que ya existían, sin pedir secretos nuevos; en la corrida de #341: 8388608 bytes, 341 trozos, 92 tests pasados, 0 salteados.
- **Prueba de despacho hostil.** `barrer-trabados.yml` y `deploy-checks.yml` despachados con `url=https://evil.example` cortaron en el paso «¿A dónde apunta esto?», como se esperaba (corridas 36375585034 y 36375587032).
- **Incidente del token de WhatsApp (28/09).** El primer intento del script de plantillas leyó mal `.env.local` (la línea del token termina en un comentario) y Graph devolvió el token en el mensaje de error, que quedó en la salida de la sesión local; no salió a ningún otro servicio. Por decisión del dueño el token no se rota; el script ahora tapa el token en toda salida.
- **Avisos por aseguradora en producción.** Vercel de producción no tiene `SPECIALIST_ALERT_EMAILS` (QA sí); la migración 0034 ya está aplicada en producción, pero la lectura por lista de tenant llega recién con la promoción que trae este PR.

---

## 15. Deuda técnica restante

Hallazgos de `complexity`, `duplicate`, `docs` y `test_gap` que no están cubiertos por ningún grupo G1-G39 del plan de cambios. Algunos se relacionan con un ítem de la Sección 14 (E13, E19, E22); la relación se nota en cada uno.

- **#6** (duplicate) — la normalización de Message-ID y la extracción de dirección simple están reimplementadas en 4 lugares distintos del poller de Gmail (`src/server/email/gmail/gmail-poller.ts:130`).
- **#39** (duplicate) — `confirm-field.ts` reimplementa los chequeos de dueño y de viewer en vez de usar `puedeCambiarEstado`/`CASE_EDITOR_ROLES` ya existentes (`src/server/cases/confirm-field.ts:146`).
- **#41** (complexity) — `orchestrate.ts` tiene 2264 líneas; sólo `orchestratePostExtraction` ocupa unas 850 líneas que mezclan análisis de faltantes, envío por canal y escalación (`src/server/confirmations/orchestrate.ts:214`).
- **#54** (complexity) — import dinámico redundante de `db` ya importado de forma estática, imports sin uso, cuerpos de error 401 armados a mano (`src/app/api/user/ai-settings/route.ts:48`).
- **#60** (duplicate) — los mapas de etiqueta de tipo de reclamo y de canal están reimplementados en unos 9 lugares de la UI (`src/app/(app)/casos/[id]/page.tsx:94`).
- **#61** (duplicate) — tres indicadores de confianza distintos, con umbrales y accesibilidad que no coinciden entre sí (`src/app/(app)/casos/[id]/_components/FieldConfirmationsPanel.tsx:44`).
- **#62** (duplicate) — chequeos y tipos de rol redeclarados en vez de usar `lib/auth/roles` (`src/app/(app)/casos/[id]/page.tsx:146`).
- **#69** (complexity) — `DashboardClient.tsx` tiene 760 líneas, con condicionales constantes y subcomponentes definidos en línea (`src/app/(app)/bandeja/DashboardClient.tsx:327`).
- **#80** (duplicate) — el fallback de tarifa de factura está duplicado entre el estado de cuenta y la cartera; el estado de cuenta además agrega un filtro de tenant que RLS ya garantiza (`src/server/billing/statement.ts:150`).
- **#83** (duplicate) — el cliente redeclara los tipos de respuesta del asistente, `delivery-check` reimplementa `isSendSuccess`, y la respuesta 429 del asistente no manda `Retry-After` (`src/app/(app)/asistente/_components/CajaDelAsistente.tsx:28`).
- **#84** (test_gap) — `ultimos_30_dias` abarca 31 días de calendario y no tiene ningún test que fije ese comportamiento (`src/core/asistente/intencion.ts:119`).
- **#88** (test_gap) — no hay tests para ninguna función del ciclo de vida de fine-tuning, ni de Gemini ni de Vertex (`src/server/training/vertex-ai-fine-tuning.ts:491`).
- **#90** (duplicate) — `/api/health` reimplementa la suma de gasto mensual del presupuesto y parsea el tope de forma distinta al resto del sistema (`src/app/api/health/route.ts:525`).
- **#98** (duplicate) — `agent/export` reimplementa el parseo de IP del cliente y no respeta la preferencia por `x-vercel-forwarded-for` (`src/app/api/agent/export/route.ts:71`).
- **#99** (duplicate) — los esquemas de las rutas admin están duplicados entre los archivos de listado y de detalle (`src/app/api/admin/custom-fields/route.ts:21`).
- **#101** (complexity) — CI corre el mismo trabajo varias veces (el build se ejecuta 4 veces), lo que gasta minutos medidos de Actions en el repo privado; se relaciona con E13 (`.github/workflows/ci.yml:817`).
- **#104** (test_gap) — la autorización por ruta y el IDOR no están testeados de forma sistemática; la guarda contra auto-escalamiento de rol en `admin/users/[id]` no tiene test (`src/app/api/admin/users/[id]/route.ts:71`).
- **#105** (duplicate) — el puente de test de `@/data/scope` está copiado en 85 archivos y resuelve thenables, lo que ya escondió 15 consultas rotas en producción; se relaciona con E22 (`scripts/add-scope-bridge.mjs:1`).
- **#109** (duplicate) — los scripts viejos de base de datos parsean `.env.local` con una expresión regular propia (que además captura el retorno de carro en archivos CRLF) en vez de usar el helper compartido (`scripts/create-tenant.mjs:99`).
- **#112** (complexity) — duplicación de scripts en `package.json`: `verify` repite lint/type-check a mano (lo que exige mantenerlo sincronizado a mano con la invariante 16), dos scripts de cobertura idénticos, scripts de formato sin uso (`package.json:29`).
- **#118** (complexity) — `googleapis` (210 MB, 338 APIs, 568-688 ms de import) se usa sólo para Gmail v1 y OAuth2; se relaciona con E19 (`src/server/email/gmail/gmail-client.ts:16`).
- **#119** (complexity) — `@tanstack/react-table` se usa en un solo componente para renderizado simple de encabezado y filas; se relaciona con E19 (`src/app/(app)/bandeja/components/CasesTable.tsx:436`).
- **#123** (complexity) — `@sentry/nextjs` es la dependencia de producción más pesada y está dormida porque `SENTRY_DSN` no está seteado en ningún entorno; se relaciona con E19 (`sentry.server.config.ts:8`).
- **#124** (duplicate) — conviven majors duplicados de las mismas librerías (zod 3 y 4, `google-auth-library` 10 y 11, `dotenv` por triplicado); se relaciona con E19 (`package.json:88`).
- **#125** (duplicate) — tres formas distintas de leer `.env.local` en los scripts: el paquete `dotenv`, un parser hand-rolled y un segundo parser ad-hoc (`scripts/lib/env-local.mjs:34`).
- **#126** (duplicate) — dos sets de iconos conviven: `lucide-react` y SVG estilo Heroicons copiados a mano (`src/app/(app)/casos/[id]/_components/MessagesThread.tsx:98`).

---

## 16. Recomendaciones

Prioridad de arriba hacia abajo. Ninguna recomendación de esta lista implica pasar a un plan pago de Vercel o de Neon, mover Vertex a la región global, ni rotar el token de WhatsApp o el secreto de OAuth de Google: esas cuatro acciones quedan fuera de alcance de cualquier recomendación de este informe.

1. **Cerrar el HIGH que queda.** El ingreso de mail parcial (#0) se arregló en #328 y `scripts/cleanup-cases.ts`, que borraba en producción sin guarda, se borró en #326 (#100). Queda el loop de alta entre `/bandeja` y `/login` (#42, E20), que necesita una decisión de producto: qué ve una cuenta con sesión pero sin tenant.
2. **Seguir con los MEDIUM de autorización e integridad de datos que quedan.** El PATCH de casos ya no puede simular un sync con el core (#27, arreglado en #328). Quedan: que la migración 0019 no deje borrar filas globales desde cualquier tenant (#43, ver E5), y que el re-análisis respete la propiedad del caso (ver E3, sujeto a la decisión de producto sobre asignación de analistas).
3. **Cerrar las brechas de presupuesto de IA.** Contar el consumo del asistente por usuario real (#72, ver E11), contar tokens de extracciones fallidas (#17, ver E14) y poner un tope por remitente en el webhook de WhatsApp (#140, ver E12) antes de que un solo canal pueda agotar el presupuesto mensual de un tenant.
4. **Sacar el extractor mock del camino de producción real, o hacerlo fallar en vez de inventar datos.** El respaldo mock fabricando un reclamo de ejemplo (#12) es el único hallazgo `ai_security` con severidad corregida MEDIUM que compromete directamente la integridad de un caso real (ver E16).
5. **Hecho: dependencias sin uso dadas de baja.** `nodemailer`/`SmtpSender`, `@aws-sdk/s3-request-presigner` y `pino` se borraron en #329 sin cambio funcional. Queda `drizzle-kit`, que es sólo de desarrollo; se puede sacar cuando el dueño confirme que no usa `drizzle-kit studio`.
6. **Evaluar el reemplazo de `googleapis` por una integración más liviana de Gmail (`@googleapis/gmail`).** Es la dependencia más pesada del árbol para la funcionalidad que realmente usa (#118, ver E19); conviene medir el impacto real en tiempo de arranque antes de decidir.
7. **Endurecer la cadena de suministro de CI sin tocar el ensayo con presupuesto real.** Sacar builds duplicados de `ci.yml` (#101), poner techo de major a los overrides sin uno (#115), restringir el envío de `CRON_SECRET` a hosts conocidos desde `workflow_dispatch` (#147) y sacar las URLs de base de staging/E2E del entorno a nivel de job (#145). Aplicar primero la alternativa conservadora de E13 (sólo sacar builds duplicados) y avanzar con revisión de seguridad en Fable antes de tocar secretos.
8. **Consolidar las duplicaciones de mayor impacto en mantenimiento.** El puente de test de `@/data/scope` copiado en 85 archivos (#105, ver E22) y los mapas de etiqueta de tipo/canal reimplementados 9 veces (#60) son los que más superficie de error futuro acumulan; conviene abordarlos con la misma cautela que pide E22, dado que uno de los dos toca directamente el aislamiento por RLS.
9. **Sumar tests a los caminos sin cobertura de mayor riesgo.** El ciclo de vida completo de fine-tuning (#88) y la autorización/IDOR por ruta en endpoints admin (#104) son los `test_gap` de severidad MEDIUM; son los que más conviene cubrir antes de seguir tocando esas áreas.
10. **Mandar al navegador sólo el diccionario del idioma de la cuenta.** Con las funciones del dueño, `pnpm peso` quedó en 308 kB de 310. El chunk más grande es el de i18n, con es-AR y en-US juntos (27,5 kB comprimidos); cargar sólo el que corresponde ahorraría unos 13 kB. Es un cambio de arquitectura en `src/lib/i18n` y en el layout, así que va en un PR propio, con el mismo build y la misma medición antes y después. Partir con `next/dynamic` no alcanza: el script mide todo el JavaScript del cliente.
11. **Dejar los ítems de la Sección 14 para cuando estén los bloqueos B2/B3 resueltos.** E3, E20 y varios otros dependen de una decisión de producto que todavía no está tomada; no conviene implementarlos a medias.

---

## Anexo A. Hallazgos de severidad baja

Los 104 hallazgos LOW confirmados.

| # | Tipo | Título | Archivo:línea | Resolución |
|---|---|---|---|---|
| #4 | dead_code | 17 imports sin uso en archivos de intake; la config de lint no los detecta | `src/server/email/gmail/gmail-poller.ts:48` | Arreglado en #330 (G23) |
| #5 | dead_code | `dedupe()` y `DedupeResult` nunca se llaman; sólo `checkDuplicate` está vivo | `src/server/email/dedupe.ts:88` | Arreglado en #329 (G19) |
| #6 | duplicate | La normalización de Message-ID y la extracción de dirección simple están reimplementadas localmente | `src/server/email/gmail/gmail-poller.ts:130` | Deuda: Message-ID reimplementado en 4 lugares del poller, sin cubrir |
| #7 | complexity | El poller de Gmail tiene una copia en línea de `markMessageRead`, construcciones sin efecto y una rama inalcanzable | `src/server/email/gmail/gmail-poller.ts:429` | Arreglado en #331 (G25g) |
| #8 | dead_code | Re-export obsoleto de `stripQuotedReply`/`buildConversationBody` desde el worker | `src/server/worker/extract.ts:2259` | Arreglado en #329 (G19) |
| #9 | duplicate | `dispatchOutboundEmail` repite los bloques de actualización de `claim_messages`/`outbound_messages` para éxito y falla; el comentario de cabecera está desactualizado | `src/server/email/dispatch.ts:380` | Arreglado en #331 (G25f) |
| #10 | logging | El resultado del envío de WhatsApp se loguea con JSON armado a mano en vez del logger | `src/server/confirmations/messenger.ts:550` | Arreglado en #331 (G29) |
| #11 | data_integrity | Una reentrega tardía de WhatsApp puede abrir un caso vacío | `src/server/agents/intake-agent.ts:231` | Deuda: redelivery tardía de WhatsApp puede abrir caso vacío, sin cubrir |
| #16 | security | Las pistas de memoria, indexadas por identidad de remitente no autenticada, pre-llenan PII confirmada por un analista | `src/server/memory/load.ts:88` | Sólo explicar: E17 |
| #18 | bug | `runClaimTextAgent` devuelve la promesa sin `await`, así que `ClaimAgentError` nunca se lanza | `src/server/ai/claim-agent.ts:45` | Desaparece con `runClaimTextAgent`, borrado en la limpieza de CI de octubre |
| #19 | dead_code | `seedMemoryFromExtraction` y las constantes `SEED_*` no se usan y contradicen el contrato AC14 del módulo | `src/server/memory/update.ts:189` | Arreglado en #329 (G19) |
| #20 | dead_code | `buildSafeDefault` está muerto; `gemini-extractor` lo importa sólo para un comentario | `src/server/ai/model-response.ts:210` | Arreglado en #329 (G19) |
| #21 | dead_code | Exports referenciados sólo por tests: `COST_PER_*_TOKEN`, `hasProviderKey`, `extractJsonObjectText` | `src/server/ai/budget.ts:31` | Arreglado en #329 (G19) |
| #22 | security | Import sin uso del cliente `db` (sin tenant) en módulos con alcance de tenant | `src/server/ai/agent-tools.ts:29` | Arreglado en #330 (G23) |
| #23 | duplicate | Comparaciones SQL de número de póliza normalizado y de sólo dígitos copiadas en 11 lugares | `src/server/matching/customer-matcher.ts:225` | Arreglado en #331 (G25h) |
| #24 | duplicate | Copias locales chicas de helpers compartidos en `export.ts` y en la ruta de salud | `src/server/agents/export.ts:26` | Parcial en #331 (G25b): export.ts corregido, health route sin mencionar |
| #25 | docs | Documentación y cabeceras desactualizadas que describen OpenAI, topes incorrectos y el selector mock incorrecto | `docs/adr/0004-prompt-injection-containment.md:20` | Arreglado en #331 (G31) |
| #28 | security | El `force` de `sync-to-core` no es exclusivo de admin; sus escrituras saltean la FSM y no tienen guarda | `src/app/api/cases/[id]/sync-to-core/route.ts:102` | Sólo explicar: E25 |
| #33 | security | `export-to-core` y `/api/metricas` saltean `entrar()` (sin límite de tasa); las exportaciones de PII no dejan auditoría | `src/app/api/cases/[id]/export-to-core/route.ts:41` | Deuda: export-to-core sin entrar()/rate limit ni auditoría, no cubierto |
| #34 | error_handling | El catch-all alrededor de `entrar()` convierte fallas de DB y de límite de tasa en un 401 `MISSING_SESSION` | `src/app/api/cases/[id]/route.ts:37` | Deuda: catch-all de entrar() convierte error de DB en 401 |
| #35 | dead_code | Imports sin uso eliminados por TypeScript en todo el subsistema; el lint no los detecta | `src/server/cases/patch.ts:17` | Arreglado en #330 (G23) |
| #36 | dead_code | Tipos `CaseStatusEmail` duplicados y sin uso | `src/lib/schemas/cases.ts:53` | Arreglado en #329 (G19) |
| #37 | dead_code | Exports de runtime alcanzados sólo desde tests | `src/core/case/fsm.ts` | Parcial en #329 (G19): sólo CaseStatusEmail borrado, otros exports de fsm.ts sin revisar |
| #38 | duplicate | Helper de extracción de código de error duplicado 8 veces más unas 100 copias en línea | `src/server/cases/get.ts:97` | Arreglado en #331 (G25a) |
| #39 | duplicate | Chequeos de dueño y de viewer reimplementados en vez de `puedeCambiarEstado`/`CASE_EDITOR_ROLES` | `src/server/cases/confirm-field.ts:146` | Deuda: confirm-field.ts reimplementa chequeos, no cubierto |
| #40 | security | La propiedad del caso por parte del analista se aplica de forma inconsistente entre mutaciones | `src/app/api/cases/[id]/responder/route.ts` | Sólo explicar: E25 |
| #41 | complexity | `orchestrate.ts` tiene 2264 líneas; `orchestratePostExtraction` ocupa unas 850 | `src/server/confirmations/orchestrate.ts:214` | Deuda: orchestrate.ts de 2264 líneas, sin dividir |
| #44 | security | Buckets de límite de tasa de auth partidos entre ruta HTTP y Server Actions; el límite de reset es por (IP, dirección), no por dirección | `src/app/api/auth/[...all]/route.ts:75` | Sólo explicar: E21 |
| #46 | docs | 16 comentarios dicen que "RLS se sacó", pero RLS es hoy el único límite de tenant para las consultas `enTenant` | `src/lib/auth/require-role.ts:17` | Arreglado en #331 (G31) |
| #47 | security | `audit_log` es append-only sólo por convención: `claimmix_app` tiene UPDATE/DELETE sobre esa tabla | `scripts/create-app-role.mts:91` | Sólo explicar: E6 |
| #48 | dead_code | Los prefijos públicos `/api` y la rama de 401 en JSON del proxy son inalcanzables (el matcher excluye `/api`) | `src/proxy.ts:152` | Arreglado en #329 (G20) |
| #49 | dead_code | Re-export sin uso en `src/app/(auth)/sign-in/SignInForm.tsx` | `src/app/(auth)/sign-in/SignInForm.tsx:6` | Arreglado en #329 (G20) |
| #50 | dead_code | 56 de 67 tipos exportados en `src/lib/db/types.ts` no tienen ninguna referencia; `UserRole` duplica `roles.ts` | `src/lib/db/types.ts:88` | Parcial en #329 (G19): 56 tipos sin uso borrados, UserRole duplicado sigue |
| #51 | duplicate | Enum de rol escrito a mano 3 veces y `ADMIN_EMAILS` parseado 2 veces en vez de la fuente única | `src/app/api/admin/users/[id]/route.ts:21` | Arreglado en #331 (G25d/e) |
| #52 | duplicate | `oauth-state.ts` tiene una comparación de tiempo constante privada, hand-rolled, que duplica `security/compare.ts` | `src/lib/auth/oauth-state.ts:92` | Arreglado en #326 (G6) |
| #53 | dead_code | Exports usados sólo en tests: `respond` created/noContent, `checkRateLimit` de sync, `EMAIL_INTAKE_WEBHOOK`, `MeResponseSchema` | `src/lib/rate-limit/index.ts:46` | Deuda: exports usados sólo por tests en rate-limit/index.ts, sin limpiar |
| #54 | complexity | Import dinámico redundante, imports sin uso, cuerpos de 401 armados a mano | `src/app/api/user/ai-settings/route.ts:48` | Deuda: import dinámico y cuerpos 401 a mano, no cubierto pese a overlap |
| #55 | data_integrity | El campo `ip` de auditoría puede ser un valor no-IP (`'anonymous'`) sobre una columna `inet`, lo que descarta la fila en silencio; `ip_prefix` sólo soporta IPv4 | `src/lib/rate-limit/index.ts:355` | Parcial en #328 (G14): ip "anonymous" ahora da null, ip_prefix sigue IPv4-only |
| #63 | dead_code | `KpiTile` en `ui.tsx` no tiene ningún importador | `src/app/(app)/_components/ui.tsx:114` | Arreglado en #329 (G20) |
| #64 | dead_code | `ROTULO_GRUPO` y el export `statusLabels` del catálogo de casos no se usan | `src/app/(app)/bandeja/components/chip.ts:57` | Arreglado en #329 (G20) |
| #65 | dead_code | `computeStatusCounts` es de uso exclusivo de tests, y su re-export no se usa | `src/app/(app)/bandeja/components/casesRealtimeUtils.ts:32` | Arreglado en #329 (G20) |
| #66 | dead_code | Unas 60 claves del diccionario no tienen ninguna referencia | `src/lib/i18n/es-AR.ts` | Deuda: unas 60 claves de diccionario sin referencia, sin limpiar |
| #67 | dead_code | Ruta huérfana `/analisis` y placeholder `/dashboard` | `src/app/(app)/analisis/page.tsx` | Deuda: ruta huérfana /analisis y placeholder /dashboard, sin abordar |
| #68 | duplicate | La bandeja copia a mano enums del esquema y el formato del número de caso | `src/app/(app)/bandeja/page.tsx:31` | Arreglado en #331 (G26) |
| #69 | complexity | `DashboardClient` está sobredimensionado, con condicionales constantes y subcomponentes en línea | `src/app/(app)/bandeja/DashboardClient.tsx:327` | Deuda: DashboardClient.tsx de 760 líneas, sin dividir |
| #70 | other | El link activo del Sidebar no tiene `aria-current`, y las etiquetas de navegación cargan fallbacks muertos | `src/app/(app)/_components/Sidebar.tsx:115` | Arreglado en #331 (G27, G28) |
| #73 | security | `SPECIALIST_ALERT_EMAILS` es una lista global de entorno que sobreescribe los destinatarios de todos los tenants | `src/server/notify/specialist-alert.ts:60` | Sólo explicar: E10 |
| #74 | error_handling | `GET /api/admin/billing` devuelve 500 `INTERNAL_ERROR` tanto para un mes inválido como para un tenant inexistente | `src/app/api/admin/billing/route.ts:39` | Deuda: admin/billing/route.ts sigue devolviendo 500 ante mes inválido |
| #77 | dead_code | Imports y variables locales sin uso en el módulo (el lint tiene `no-unused-vars`/`noUnusedLocals` apagados) | `src/server/billing/statement.ts:29` | Arreglado en #330 (G23) |
| #78 | dead_code | `COST_PER_PROMPT_TOKEN`/`COST_PER_COMPLETION_TOKEN`, deprecados, no tienen llamadores en producción | `src/server/ai/budget.ts:32` | Arreglado en #329 (G19) |
| #79 | complexity | `specialist-alert` importa dinámicamente un esquema que ya está importado de forma estática, y usa un `and()` de un solo argumento | `src/server/notify/specialist-alert.ts:303` | Arreglado en #331 (G25j) |
| #80 | duplicate | El fallback de tarifa de factura está duplicado entre el estado de cuenta y la cartera; el estado de cuenta agrega además un filtro de tenant que RLS ya garantiza | `src/server/billing/statement.ts:150` | Deuda: fallback de tarifa duplicado entre estado de cuenta y cartera |
| #81 | dead_code | `BILLING_STATUSES`/`isBillingStatus` sólo los usa su propio test unitario | `src/lib/billing/plans.ts:74` | Deuda: BILLING_STATUSES/isBillingStatus usados sólo por su propio test |
| #82 | docs | Comentarios de cabecera desactualizados que describen precios de gpt-4o, un cliente de service-role y "RLS sacado / filtro explícito de tenant_id" | `src/server/ai/budget.ts:1` | Arreglado en #331 (G31) |
| #83 | duplicate | El cliente redeclara los tipos de respuesta del asistente; `delivery-check` reimplementa `isSendSuccess`; la respuesta 429 del respondedor no manda `Retry-After` | `src/app/(app)/asistente/_components/CajaDelAsistente.tsx:28` | Deuda: tipos de respuesta del asistente redeclarados, sin cubrir |
| #84 | test_gap | `ultimos_30_dias` abarca 31 días de calendario y no tiene test | `src/core/asistente/intencion.ts:119` | Deuda: ultimos_30_dias sin test que fije el comportamiento |
| #87 | security | `/api/admin/health`, público, expone texto crudo de error de DB; `aiMode` se calcula y se descarta | `src/app/api/admin/health/route.ts:49` | Arreglado en #326 (G4) y #333 (G37) |
| #92 | unused_dependency | `@aws-sdk/s3-request-presigner` nunca se importa | `package.json:72` | Arreglado en #329 (G22) |
| #93 | dead_code | Imports sin uso, incluido el `db` de rol dueño en módulos con alcance de RLS | `src/server/training/vertex-ai-fine-tuning.ts:26` | Arreglado en #330 (G23) |
| #94 | duplicate | El split de entrenamiento/validación JSONL y `OPEN_JOB_STATUSES` están duplicados entre los dos módulos de fine-tuning | `src/server/training/fine-tuning.ts:215` | Arreglado en #331 (G25i) |
| #95 | dead_code | Ramas de error muertas con texto mojibake de cara al usuario en la ruta de jobs de fine-tuning | `src/app/api/admin/fine-tuning/jobs/[id]/route.ts:62` | Arreglado en #329 (G19) |
| #96 | error_handling | JSON malformado e ids desconocidos devuelven 500 en `prompt-rules` y `gmail-accounts` | `src/app/api/admin/gmail-accounts/route.ts:67` | Parcial en #328 (G18): gmail-accounts corregido, prompt-rules sin mencionar |
| #97 | logging | Deshabilitar o borrar el buzón de intake no queda auditado; `isAdmin` y `user` no se usan | `src/app/api/admin/gmail-accounts/route.ts:108` | Parcial en #328 (G18): variables sin uso borradas, falta auditar baja de casilla |
| #98 | duplicate | `agent/export` reimplementa el parseo de IP del cliente y no respeta la preferencia por `x-vercel-forwarded-for` | `src/app/api/agent/export/route.ts:71` | Deuda: agent/export reimplementa parseo de IP, sin cubrir |
| #99 | duplicate | Esquemas de rutas admin duplicados entre archivos de listado y de detalle, más exports sin uso en `lib/schemas` | `src/app/api/admin/custom-fields/route.ts:21` | Deuda: esquemas de rutas admin duplicados, sin cubrir |
| #103 | unused_dependency | Overrides sin techo de `nanoid`/`js-yaml` cruzan majors contra los rangos declarados; el override de `form-data` está muerto | `package.json:130` | Parcial en #329 (G22): override form-data sacado, techo de nanoid/js-yaml sin poner |
| #107 | dead_code | Los codemods de filtro de tenant están obsoletos; `count-tenant-filters` duplica la invariante 3 de `check-architecture` | `scripts/migrate-tenant-filters.mjs:1` | Parcial en #329 (G21): migrate/analyze/declare borrados, count-tenant-filters se conserva |
| #108 | dead_code | Scripts puntuales sin referencia; `sync-vercel-env` puede dejar una variable de Vercel de producción borrada | `scripts/sync-vercel-env.mjs:47` | Deuda: sync-vercel-env.mjs se conserva, lo corre el dueño a mano |
| #109 | duplicate | Los scripts viejos de DB parsean `.env.local` con una expresión regular (captura `\r` en CRLF) en vez de `scripts/lib/env-local.mjs`/`db-driver.mjs` | `scripts/create-tenant.mjs:99` | Deuda: scripts viejos parsean .env.local con regex propia, sin cubrir |
| #110 | unused_dependency | `pino` y `@aws-sdk/s3-request-presigner` son dependencias de runtime sin uso | `package.json:84` | Arreglado en #329 (G22) |
| #111 | dead_code | Archivos de test/config muertos: `tests/mocks/db.ts`, `tests/fixtures/tenants.sql`, `.size-limit.cjs`, exclusión de `tests/stress` en vitest | `tests/mocks/db.ts:1` | Parcial en #329 (G21): archivos muertos borrados, exclude de vitest tests/stress sin mencionar |
| #112 | complexity | Duplicación de scripts en `package.json`: `verify` repite lint/type-check (exige sincronizar a mano la invariante 16), dos scripts de cobertura idénticos, scripts de formato sin uso | `package.json:29` | Deuda: duplicación de scripts en package.json, sin cubrir |
| #113 | docs | Documentos de arquitectura y ADRs desactualizados que contradicen el sistema actual | `docs/ARQUITECTURA.md:438` | Arreglado en #331 (G31) |
| #115 | security | Cuatro overrides sin techo de major fuerzan versiones que sus dependientes nunca declararon, contra la propia regla del repo | `package.json:130` | Deuda: cuatro overrides sin techo de major, sin cubrir |
| #116 | unused_dependency | `pino` es una dependencia de producción que nunca se importa | `package.json:84` | Arreglado en #329 (G22) |
| #117 | unused_dependency | `@aws-sdk/s3-request-presigner` nunca se importa; los adjuntos se manejan por streaming, no por presigned URL | `package.json:72` | Arreglado en #329 (G22) |
| #119 | complexity | `@tanstack/react-table` se usa en un solo componente para renderizado simple de encabezado y filas | `src/app/(app)/bandeja/components/CasesTable.tsx:436` | Sólo explicar: E19 |
| #120 | dead_code | El override de `form-data` apunta a un paquete que no está en el árbol de dependencias | `package.json:121` | Arreglado en #329 (G22) |
| #121 | dead_code | `.size-limit.cjs` es config versionada de un tool que no está instalado, con un presupuesto que no coincide con el real | `.size-limit.cjs:1` | Arreglado en #329 (G21) |
| #122 | unused_dependency | `drizzle-kit` y `drizzle.config.ts` están huérfanos; las migraciones se escriben a mano y se aplican con `scripts/migrate.mjs` | `drizzle.config.ts:1` | Deuda: `drizzle-kit` y `drizzle.config.ts` se mantienen (sin uso en scripts ni CI; borrarlos no aporta y el dueño puede querer `drizzle-kit studio`) |
| #123 | complexity | `@sentry/nextjs` es la dependencia de producción más pesada y está dormida; sólo se usa su inicialización de Node | `sentry.server.config.ts:8` | Sólo explicar: E19 |
| #124 | duplicate | Majors duplicados de las mismas librerías en el árbol de servidor (zod 3 y 4, `google-auth-library` 10 y 11, `dotenv` por triplicado) | `package.json:88` | Sólo explicar: E19 |
| #125 | duplicate | Tres formas de leer `.env.local` en scripts: el paquete `dotenv`, un parser hand-rolled y un segundo parser ad-hoc | `scripts/lib/env-local.mjs:34` | Deuda: tres formas de leer .env.local en scripts, sin cubrir |
| #126 | duplicate | Dos sets de iconos: `lucide-react` más SVG en línea copiados a mano estilo Heroicons | `src/app/(app)/casos/[id]/_components/MessagesThread.tsx:98` | Deuda: dos sets de iconos conviven, sin cubrir |
| #128 | bug | La vía de escape de admin en el re-análisis chequea `role === "admin"` y excluye al dueño | `src/app/api/cases/[id]/re-analyze/route.ts:125` | Arreglado en #328 (G2) |
| #129 | bug | `confirm-training` acepta un `agent_run_id` de otro caso del mismo tenant | `src/app/api/cases/[id]/confirm-training/route.ts:96` | Arreglado en #326 (G8) |
| #130 | other | `demo/analyze` deja que un viewer corra extracción de Gemini contra el presupuesto del tenant | `src/app/api/demo/analyze/route.ts:42` | Sólo explicar: E9 |
| #131 | dead_code | 38 archivos importan la conexión `db` del dueño (BYPASSRLS) y nunca la usan | `src/app/api/cases/[id]/route.ts:16` | Arreglado en #330 (G23) |
| #132 | duplicate | La página de configuración calcula el mismo flag de admin dos veces bajo dos nombres distintos | `src/app/(app)/configuracion/page.tsx:102` | Arreglado en #331 (G26) |
| #133 | other | `export-to-core` saltea la guarda compartida `entrar()` y no tiene límite de tasa | `src/app/api/cases/[id]/export-to-core/route.ts:41` | Deuda: export-to-core sin entrar()/rate limit, mismo hallazgo que #33 |
| #135 | data_integrity | `isOwnMailbox` saltea mails cuyo `From` matchea el buzón conectado de CUALQUIER tenant, en silencio y sin auditoría | `src/server/email/gmail/gmail-poller.ts:313` | Deuda: isOwnMailbox salta mail de otra casilla del tenant, sin auditar |
| #136 | security | Líneas de cabecera RFC 2822 crudas concatenadas a partir de valores derivados del mail entrante, sin guarda de CR/LF | `src/server/email/gmail/gmail-sender.ts:79` | Arreglado en #326 (G5) |
| #137 | logging | El `beforeSend` de Sentry sólo depura los mensajes de excepción; el mensaje, los breadcrumbs, cabeceras, cookies y datos extra pasan sin filtrar | `sentry.server.config.ts:15` | Deuda: Sentry beforeSend no filtra breadcrumbs/headers/cookies/extra |
| #138 | logging | Errores no manejados y errores de proveedor se loguean tal cual; el logger no tiene capa de redacción | `src/lib/api/respond.ts:118` | Deuda: logger sin capa de redacción, errores se loguean textuales |
| #141 | data_integrity | El libro de salida de WhatsApp se escribe después del envío y de mejor esfuerzo, a diferencia del camino de mail; las guardas de deduplicación fallan abierto | `src/server/confirmations/messenger.ts:541` | Parcial en #328 (G13): alternativa conservadora mantiene best-effort si falla el insert |
| #142 | ai_security | La guarda de resumen del asistente sólo rechaza corridas de 8 o más dígitos; montos con puntos o de 7 dígitos escritos por el reclamante pueden colarse como hechos del caso | `src/server/asistente/responder.ts:99` | Arreglado en #327 (G12) |
| #143 | docs | La ADR 0004 describe la pila de OpenAI y una FSM incompleta; la garantía de seguridad sigue vigente en el código | `docs/adr/0004-prompt-injection-containment.md:25` | Arreglado en #331 (G31) |
| #144 | ai_security | `knownValues` se interpola en los prompts de planificador y compositor sin pasar por `sinCentinelas`, a diferencia de las entradas vecinas | `src/server/ai/deliberate.ts:304` | Arreglado en #327 (G11) |
| #145 | security | URLs de base de staging/E2E en el entorno a nivel de job, expuestas a los scripts de instalación de pnpm y a cualquier paso del job | `.github/workflows/ci.yml:251` | Sólo explicar: E13 |
| #146 | security | pnpm 9 corre los scripts de instalación de cada dependencia; sin lista blanca ni `ignore-scripts` | `package.json:114` | Sólo explicar: E13 |
| #147 | security | Las entradas de URL de `workflow_dispatch` mandan `CRON_SECRET` a cualquier host; sólo `load-tests` valida el host | `.github/workflows/barrer-trabados.yml:103` | Sólo explicar: E13 |
| #148 | security | Expresiones interpoladas directo en scripts `run:`, contra la convención propia del repo | `.github/workflows/load-tests.yml:100` | Sólo explicar: E13 |
| #149 | docs | `.env.example` omite variables que el código requiere, incluido el cuarteto de WIF y la clave de cifrado de tokens | `.env.example` | Arreglado en #331 (G31) |
| #150 | security | La contraseña del rol de aplicación viaja en texto plano dentro del texto de la sentencia DDL | `scripts/create-app-role.mts:72` | Deuda: password del rol de la app viaja en texto plano en el DDL |

---

## Anexo B. Hallazgos refutados

Los 12 hallazgos que no se confirmaron, con la razón de la refutación.

1. **`runEmailExtractionWorker` es una función de unas 915 líneas en un archivo de 2259** (`src/server/worker/extract.ts`) — el tamaño es real, pero la evidencia decía además que `runExtractionWorker` (líneas 133-382) estaba "muerto"; es falso: está exportado, testeado activamente en `tests/integration/worker.test.ts` con 9 o más sitios de llamada, y documentado como objetivo de deploy. Nota posterior: el hallazgo #1 sí se confirmó por separado (nada en producción llama a `runExtractionWorker`; el test era su único usuario) y la función se borró en #329 junto con ese test.
2. **`simulatedWhatsappMessenger.send` no tiene `try/catch`, a diferencia de los mensajeros reales** (`src/server/confirmations/messenger.ts`) — la premisa de que `writeReply` puede lanzar es falsa: llama a `composeReply`, cuyo propio contrato documentado es no lanzar nunca y usar la respuesta de respaldo ante cualquier falla.
3. **El encadenamiento de herramientas hace que "probar ser el titular" en `verificar_poliza` equivalga a conocer un DNI** (`src/server/ai/agent-tools.ts`) — la cadena existe, pero es el diseño documentado y testeado, no una debilidad no intencional: el DNI siempre fue la prueba de titularidad, según el propio comentario del archivo y el test unitario correspondiente.
4. **El proveedor de límite de tasa de Upstash es un stub para paquetes no instalados, pero figura en `serverExternalPackages`** (`next.config.ts`) — es así, pero el archivo ya trae un comentario explícito justo arriba de esa entrada explicando que es una dependencia opcional para una futura actualización, no un error.
5. **La fila de cartera de un mes congelado mezcla el total de factura congelado con costo de IA, margen y términos vigentes** (`src/server/billing/tenant-summary.ts`) — la mezcla es explícita y documentada: un comentario extenso explica que el total facturado se congela por diseño, mientras costo y margen se recalculan siempre con los valores vigentes.
6. **El enmascarado de viewer difiere según la superficie: el asistente oculta 6 campos, el detalle de caso los devuelve todos** (`src/server/asistente/herramientas.ts`) — los hechos son ciertos, pero es una decisión de producto documentada y registrada en `docs/PROJECT_STATUS.md`, no un defecto de autorización.
7. **La guarda anti-inyección de fórmulas del CSV no cubre TAB inicial ni CR** (`src/lib/csv/safe-encode.ts`) — el hueco literal existe, pero el único llamador exporta sólo campos controlados por el servidor (UUID, enums, fechas formateadas); el campo con texto libre del reclamante nunca pasa por esa función, así que no hay camino de explotación real.
8. **`load-tests.yml` manda el `CRON_SECRET` de producción a despliegues de preview construidos desde código de rama** (`.github/workflows/load-tests.yml`) — refutado en su premisa central: el repo documenta a propósito que el alcance de Preview en Vercel tiene el mismo valor de `CRON_SECRET` que producción, según `docs/PROMOCION.md`.
9. **`@opentelemetry/core` está fijado en 2.8.0 mientras sus paquetes hermanos de otel piden exactamente 2.11.0** (`package.json`) — el pin tiene una razón real: `@sentry/node-core` y `@sentry/opentelemetry`, ambos instalados, declaran una `peerDependency` exacta en 2.8.0, así que la fijación es necesaria, no un descuido.
10. **El límite de PII para viewer es inconsistente: el asistente y los adjuntos ocultan identificadores, tres endpoints de caso los devuelven crudos** (`src/app/api/cases/[id]/extraction.json/route.ts`) — los hechos de código son correctos, pero es una decisión de producto documentada en `lib/auth/roles.ts` y registrada en `docs/PROJECT_STATUS.md`, no un defecto de autorización no intencional.
11. **La guarda anti-inyección de fórmulas del CSV cubre `= + - @` pero no tab, CR ni pipe** (`src/lib/csv/safe-encode.ts`) — refutado sobre el camino de datos real: el único llamador exporta campos server-formateados (UUID, enums, fecha, confianza); los campos con texto libre del reclamante, que serían la fuente del ataque, no se exportan por esa vía.
12. **`polizas_por_dni` y `verificar_poliza` le dan al modelo la lista de pólizas y datos de vehículo/patente en base a un DNI tipeado** (`src/server/ai/agent-tools.ts`) — refutado: la regla de DNI-como-prueba es el diseño documentado y testeado, no una pregunta abierta; el propio encabezado del archivo y el test unitario correspondiente lo dejan explícito.

---

Gap: file not written, tool policy block. No data gap otherwise — todo confirmado: 3 HIGH + 44 MEDIUM + 104 LOW = 151, 12 rejected, todo con file:line y evidencia.