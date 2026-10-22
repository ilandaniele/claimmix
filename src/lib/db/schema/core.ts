/**
 * Core app tables: tenants, users, cases, raw_messages, extracted_fields,
 * missing_docs, outbound_messages, audit_log, ai_usage, required_docs_config.
 *
 * Source of truth: neon/migrations/0001_init.sql. These TS definitions are for
 * query building / type inference only — CHECK constraints, indexes and
 * triggers live in the SQL migration and are intentionally not declared here.
 *
 * NOTE: property keys are intentionally IDENTICAL to the snake_case column
 * names to preserve existing JSON response shapes.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { Reglas } from "@/core/case/asignacion";
import type { MontoEstimado, RangosDeMonto } from "@/core/case/monto-estimado";
import type { Plan } from "@/core/case/plan-de-trabajo";
import type { PlazoPropio } from "@/core/case/plazos";
import type { Pesos } from "@/core/case/puntaje-complejidad";
import type { Responsabilidad } from "@/core/case/responsabilidad";

import { authUsers } from "./auth";

/**
 * A tenant is one insurer or broker, and these columns are its contract.
 *
 * The billable unit is a CLAIM, not a token: `monthly_fee_usd` covers
 * `included_claims` per calendar month, and every claim past that costs
 * `overage_price_usd`. Cost is tracked separately in `ai_usage` — this is the
 * revenue side, and the two together are what /api/admin/billing reports.
 *
 * Defaults describe a pilot (free, 300 claims), so a tenant created without
 * commercial terms is never accidentally billed.
 */
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  plan: text("plan", {
    enum: ["piloto", "operativo", "profesional", "corporativo", "enterprise"],
  })
    .notNull()
    .default("piloto"),
  billing_status: text("billing_status", {
    enum: ["trial", "active", "suspended", "churned"],
  })
    .notNull()
    .default("trial"),
  monthly_fee_usd: numeric("monthly_fee_usd", { precision: 10, scale: 2 })
    .notNull()
    .default("0"),
  included_claims: integer("included_claims").notNull().default(300),
  overage_price_usd: numeric("overage_price_usd", { precision: 10, scale: 4 })
    .notNull()
    .default("0"),
  contact_email: text("contact_email"),
  trial_ends_at: timestamp("trial_ends_at", { withTimezone: true, mode: "string" }),
  activated_at: timestamp("activated_at", { withTimezone: true, mode: "string" }),
  specialist_alert_emails: text("specialist_alert_emails").array().notNull().default(sql`'{}'::text[]`),
  // Horas sin respuesta a las que se repite el pedido de lo que falta; vacío =
  // apagado (migración 0039).
  recordatorio_horas: integer("recordatorio_horas").array().notNull().default(sql`'{}'::integer[]`),
  // La tabla de montos propia; NULL = la de por defecto (migración 0040).
  rangos_de_monto: jsonb("rangos_de_monto").$type<RangosDeMonto>(),
  // Cómo trabaja el equipo de esta aseguradora, sólo para el equipo; NULL = los
  // valores por defecto del código (migración 0042).
  reglas_asignacion: jsonb("reglas_asignacion").$type<Reglas>(),
  plazos: jsonb("plazos").$type<PlazoPropio[]>(),
  plan_por_tipo: jsonb("plan_por_tipo").$type<Plan>(),
  pesos_puntaje: jsonb("pesos_puntaje").$type<Pesos>(),
  // Lo creó el alta automática (migración 0048). Ninguna consulta sobre tenants
  // puede pedir todas las columnas: antes de la 0048 esta no existe (lo vigila
  // `pnpm arquitectura`).
  autoalta: boolean("autoalta").notNull().default(false),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

/**
 * El número de WhatsApp de cada inquilino y su estado (migración 0048).
 *
 * La app sólo lo lee: escriben la función claimmix_crear_inquilino y el rol
 * dueño. Un id de Meta y un número E.164 pertenecen a una sola fila viva
 * (`estado <> 'baja'`); los índices únicos parciales viven en la migración.
 * `token_cifrado` NULL = el token del usuario de sistema de la plataforma.
 */
export const whatsappNumeros = pgTable("whatsapp_numeros", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  numero_e164: text("numero_e164").notNull(),
  estado: text("estado", {
    enum: ["pedido", "conectado", "suspendido", "baja"],
  })
    .notNull()
    .default("pedido"),
  phone_number_id: text("phone_number_id"),
  waba_id: text("waba_id"),
  token_cifrado: text("token_cifrado"),
  creado_en: timestamp("creado_en", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  conectado_en: timestamp("conectado_en", { withTimezone: true, mode: "string" }),
  actualizado_en: timestamp("actualizado_en", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

/**
 * El vínculo de cada inquilino con su WABA propia, la que Meta le crea o le deja
 * elegir en Embedded Signup, o la de su propia app de Meta (migración 0051). Vive
 * sólo en control y la app sólo la lee: escribe la función claimmix_waba_propia. El
 * token del cliente no está acá, va en `whatsapp_numeros.token_cifrado`. Una WABA
 * pertenece a un solo inquilino vivo; `revocada` y `cancelada` la sueltan (índice
 * único parcial en la migración).
 *
 * `origen` dice de dónde viene el vínculo. Las columnas desde `app_id` hasta
 * `puede_enviar` son de la app propia y valen NULL en Embedded Signup (restricción
 * `whatsapp_wabas_por_origen`). `armando` es la app propia que todavía no tiene su
 * app pegada. El App Secret va cifrado con el sobre v2 de `cifrado.ts`.
 */
export const whatsappWabas = pgTable("whatsapp_wabas", {
  tenant_id: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  estado: text("estado", {
    enum: ["armando", "cancelada", "vinculada", "suscripta", "falta_codigo", "falta_pin", "conectada", "falla", "revocada"],
  }).notNull(),
  falla: text("falla"),
  paso_cancelado: text("paso_cancelado", {
    enum: [
      "business_account_selection",
      "waba_phone_profile_picker",
      "whatsapp_business_profile_setup",
      "phone_number_setup",
      "phone_number_verification",
      "permissions",
      "otro",
    ],
  }),
  business_id: text("business_id"),
  waba_id: text("waba_id"),
  fb_user_id: text("fb_user_id"),
  numero_meta: text("numero_meta"),
  numero_aceptado: boolean("numero_aceptado").notNull().default(false),
  nombre_estado: text("nombre_estado"),
  plantilla_enviada_en: timestamp("plantilla_enviada_en", { withTimezone: true, mode: "string" }),
  pin_cifrado: text("pin_cifrado"),
  intentos: integer("intentos").notNull().default(0),
  vinculada_en: timestamp("vinculada_en", { withTimezone: true, mode: "string" }),
  origen: text("origen", { enum: ["embedded_signup", "app_propia"] })
    .notNull()
    .default("embedded_signup"),
  app_id: text("app_id"),
  app_secreto_cifrado: text("app_secreto_cifrado"),
  ruta_webhook: text("ruta_webhook"),
  webhook_app_verificado_en: timestamp("webhook_app_verificado_en", { withTimezone: true, mode: "string" }),
  datos_app_en: timestamp("datos_app_en", { withTimezone: true, mode: "string" }),
  primer_mensaje_en: timestamp("primer_mensaje_en", { withTimezone: true, mode: "string" }),
  primera_respuesta_en: timestamp("primera_respuesta_en", { withTimezone: true, mode: "string" }),
  slug_legal: text("slug_legal"),
  razon_social: text("razon_social"),
  cuit: text("cuit"),
  acuerdo_version: text("acuerdo_version"),
  recordatorio_en: timestamp("recordatorio_en", { withTimezone: true, mode: "string" }),
  puede_enviar: text("puede_enviar", { enum: ["AVAILABLE", "LIMITED", "BLOCKED"] }),
  categoria_perfil: text("categoria_perfil"),
  creado_en: timestamp("creado_en", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  actualizado_en: timestamp("actualizado_en", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

/**
 * El estado de la base propia de cada inquilino (migración 0050). Vive en la base
 * de control y sólo la lee y la escribe el rol dueño: `claimmix_app` no tiene
 * ningún permiso. Sin fila, el inquilino no tiene base propia. `tomada_at` hace de
 * lease: quien prepara la base la marca, y otro no la toma hasta que vence.
 */
export const tenantBases = pgTable("tenant_bases", {
  tenant_id: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  estado: text("estado", {
    enum: ["creando", "lista", "fallida", "borrada"],
  }).notNull(),
  version_migracion: integer("version_migracion").notNull().default(0),
  intentos: integer("intentos").notNull().default(0),
  ultimo_error: text("ultimo_error"),
  tomada_at: timestamp("tomada_at", { withTimezone: true, mode: "string" }),
  creada_at: timestamp("creada_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  lista_at: timestamp("lista_at", { withTimezone: true, mode: "string" }),
});

/**
 * El registro de migraciones que arma `scripts/migrate.mjs`: una fila por archivo
 * aplicado, con `version` de cuatro dígitos ("0050") y el checksum del archivo. La
 * 0050 le cierra el acceso a `claimmix_app`; lo leen y lo escriben los scripts y
 * el rol dueño.
 */
export const schemaMigrations = pgTable("schema_migrations", {
  version: text("version").primaryKey(),
  filename: text("filename").notNull(),
  checksum: text("checksum").notNull(),
  applied_at: timestamp("applied_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  applied_by: text("applied_by"),
});

export const users = pgTable("users", {
  id: uuid("id")
    .primaryKey()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  full_name: text("full_name").notNull(),
  role: text("role", {
    enum: ["owner", "admin", "specialist", "analyst", "viewer"],
  })
    .notNull()
    .default("analyst"),
  locale: text("locale"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  /** null = activo. Con fecha, la persona no entra más (0053). */
  dado_de_baja_en: timestamp("dado_de_baja_en", { withTimezone: true, mode: "string" }),
});

/**
 * La liquidación de un mes que ya cerró, tal como se emitió.
 *
 * /api/admin/billing recalcula desde `cases`, y para el mes en curso eso es
 * lo correcto. Para un mes terminado no: borrar casos viejos, corregir un
 * `is_claim` o cambiar de plan mueven una cifra que un cliente ya pagó. Acá
 * queda la copia, con los términos que se usaron y la respuesta entera del día
 * del cierre — sin eso la factura no se puede defender línea por línea.
 *
 * Ver neon/migrations/0017_billing_invoice_snapshots.sql.
 */
export const billingInvoices = pgTable("billing_invoices", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  month: text("month").notNull(),
  period_start: timestamp("period_start", { withTimezone: true, mode: "string" }).notNull(),
  period_end: timestamp("period_end", { withTimezone: true, mode: "string" }).notNull(),
  billable_claims: integer("billable_claims").notNull(),
  total_usd: numeric("total_usd", { precision: 12, scale: 2 }).notNull(),
  ai_cost_usd: numeric("ai_cost_usd", { precision: 12, scale: 4 }).notNull(),
  plan: text("plan").notNull(),
  monthly_fee_usd: numeric("monthly_fee_usd", { precision: 10, scale: 2 }).notNull(),
  included_claims: integer("included_claims").notNull(),
  overage_price_usd: numeric("overage_price_usd", { precision: 10, scale: 4 }).notNull(),
  payload: jsonb("payload").notNull(),
  frozen_at: timestamp("frozen_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const cases = pgTable("cases", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  policy_number: text("policy_number"),
  policyholder_name: text("policyholder_name"),
  claim_type: text("claim_type"),
  status: text("status", {
    enum: [
      "procesando",
      "listo",
      "esperando",
      "escalado",
      "cerrado",
      "recibido",
      "info_faltante",
      "confirmacion_pendiente",
      "requiere_especialista",
      "listo_para_core",
      "enviado_a_core",
      "error_core",
      "no_relevante",
      "en_liquidacion",
      "pagado",
      "rechazado",
    ],
  })
    .notNull()
    .default("procesando"),
  confidence_min: numeric("confidence_min", { precision: 3, scale: 2 }),
  assigned_to: uuid("assigned_to").references(() => users.id, {
    onDelete: "set null",
  }),
  channel: text("channel").notNull().default("email_sim"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  closed_at: timestamp("closed_at", { withTimezone: true, mode: "string" }),
  /**
   * Held while an extraction run owns this case. A lease, not a lock: it
   * expires, so a crashed run cannot wedge the case forever.
   */
  extraction_lease_at: timestamp("extraction_lease_at", {
    withTimezone: true,
    mode: "string",
  }),
  /** A message arrived while a run was in flight; the holder must run again. */
  extraction_pending: boolean("extraction_pending").default(false).notNull(),
  /**
   * Cuántas veces se reintentó la extracción tras un timeout del proveedor.
   *
   * Un timeout es transitorio y merece otro intento — pero un mensaje que
   * SIEMPRE agota el plazo se reintentaría para siempre, pagando una llamada
   * cada vez. Pasado el tope del código, escala. Ver la migración 0030.
   */
  intentos_de_extraccion: smallint("intentos_de_extraccion").default(0).notNull(),
  email_message_id: text("email_message_id"),
  email_thread_id: text("email_thread_id"),
  is_claim: boolean("is_claim"),
  not_relevant_reason: text("not_relevant_reason"),
  requires_specialist: boolean("requires_specialist").notNull().default(false),
  severity: text("severity"),
  core_external_id: text("core_external_id"),
  core_error_message: text("core_error_message"),
  core_sent_at: timestamp("core_sent_at", { withTimezone: true, mode: "string" }),
  fields_pending_confirmation: jsonb("fields_pending_confirmation")
    .notNull()
    .default(sql`'[]'::jsonb`),
  // FK to public.customers(id) ON DELETE SET NULL — declared as plain uuid to
  // avoid a circular import with ./crm (crm imports tenants/users from here).
  customer_id: uuid("customer_id"),
  // FK to public.policies(id) ON DELETE SET NULL — plain uuid, same reason.
  policy_id: uuid("policy_id"),
  // Fraud risk assessment (set by AI extractor, migration 0009)
  fraud_risk_level: text("fraud_risk_level").default("none"),
  fraud_indicators: jsonb("fraud_indicators").default(sql`'[]'::jsonb`),
  // Resumen del caso que devuelve la extracción, ya filtrado (migración 0037).
  resumen: text("resumen"),
  // Granular injury severity (migration 0009)
  injury_severity: text("injury_severity"),
  // Llegó un mensaje después de que el agente terminó; lo contesta una persona
  // (migración 0031).
  para_responder_desde: timestamp("para_responder_desde", {
    withTimezone: true,
    mode: "string",
  }),
  // Qué pidió ese mensaje tardío, clasificado por el worker (migración 0038).
  mensaje_tardio_de: uuid("mensaje_tardio_de"),
  mensaje_tardio_tipo: text("mensaje_tardio_tipo"),
  mensaje_tardio_resumen: text("mensaje_tardio_resumen"),
  mensaje_tardio_reservado_en: timestamp("mensaje_tardio_reservado_en", {
    withTimezone: true,
    mode: "string",
  }),
  // Rango orientativo, sólo para el equipo (migración 0040).
  monto_estimado: jsonb("monto_estimado").$type<MontoEstimado>(),
  // Opinión orientativa de responsabilidad en un choque, sólo para el equipo
  // (migración 0041). La mecánica en la que se apoya no se guarda acá.
  responsabilidad: jsonb("responsabilidad").$type<Responsabilidad>(),
  // Ordenar el trabajo del equipo: puntaje de 0 a 100 y próximo vencimiento con
  // su clave. NULL = sin calcular / sin plazo corriendo (migración 0042).
  puntaje_complejidad: smallint("puntaje_complejidad"),
  vence_en: timestamp("vence_en", { withTimezone: true, mode: "string" }),
  vence_plazo: text("vence_plazo"),
});

export const rawMessages = pgTable("raw_messages", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  case_id: uuid("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  from_addr: text("from_addr"),
  subject: text("subject"),
  body: text("body").notNull(),
  received_at: timestamp("received_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const extractedFields = pgTable("extracted_fields", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  case_id: uuid("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  field_key: text("field_key").notNull(),
  field_value: text("field_value").notNull(),
  confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull(),
  extracted_at: timestamp("extracted_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const missingDocs = pgTable("missing_docs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  case_id: uuid("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  doc_key: text("doc_key").notNull(),
  requested_at: timestamp("requested_at", { withTimezone: true, mode: "string" }),
  satisfied_at: timestamp("satisfied_at", { withTimezone: true, mode: "string" }),
  /**
   * When the claimant said this document does not exist.
   *
   * Deliberately not `satisfied_at`: nothing arrived. A document marked
   * received vanishes from the analyst's list and reads as "we have it"; this
   * has to read as "they told us there isn't one", which is sometimes worth
   * pushing back on.
   */
  declined_at: timestamp("declined_at", { withTimezone: true, mode: "string" }),
  /** What they said, so an analyst can judge whether to insist. */
  declined_note: text("declined_note"),
});

/**
 * Cada recordatorio o aviso de cierre que el barrido ya decidió (0039). La
 * clave primaria es la idempotencia: se inserta ANTES de mandar, y el que no
 * inserta no manda. Sin UPDATE ni DELETE para `claimmix_app`.
 */
export const caseRecordatorios = pgTable(
  "case_recordatorios",
  {
    case_id: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    tenant_id: uuid("tenant_id").notNull(),
    ancla: timestamp("ancla", { withTimezone: true, mode: "string" }).notNull(),
    etapa: smallint("etapa").notNull(),
    resultado: text("resultado").notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.case_id, t.ancla, t.etapa] })],
);

/**
 * Un paso del plan de trabajo de un caso (0042). `titulo` es una foto de la
 * plantilla al crear el plan. La clave primaria es la idempotencia: el plan se
 * crea con ON CONFLICT DO NOTHING. Sin DELETE para `claimmix_app`.
 */
export const casePlanPasos = pgTable(
  "case_plan_pasos",
  {
    case_id: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    tenant_id: uuid("tenant_id").notNull(),
    clave: text("clave").notNull(),
    titulo: text("titulo").notNull(),
    orden: smallint("orden").notNull(),
    // Estado que lo tilda solo (en_liquidacion o pagado); NULL = lo tilda una persona.
    auto: text("auto"),
    hecho_en: timestamp("hecho_en", { withTimezone: true, mode: "string" }),
    hecho_por: uuid("hecho_por").references(() => users.id, { onDelete: "set null" }),
    // 'manual' o 'auto'.
    origen: text("origen"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.case_id, t.clave] })],
);

/**
 * Un mensaje de la conversación de una persona del equipo con el asistente
 * sobre un caso (0043). La política de lectura pide inquilino Y usuario: sólo la
 * lee quien la escribió. Sin UPDATE ni DELETE para `claimmix_app`.
 */
export const asistenteTurnos = pgTable("asistente_turnos", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  tenant_id: uuid("tenant_id").notNull(),
  user_id: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  case_id: uuid("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  rol: text("rol", { enum: ["user", "assistant"] }).notNull(),
  texto: text("texto").notNull(),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

/**
 * Lo que la revisión nocturna encontró fuera de lo esperado (0043). La clave
 * primaria (caso, regla, ancla) es la idempotencia. Lo escribe el barrido con el
 * rol dueño; `claimmix_app` sólo lee.
 */
export const caseDesvios = pgTable(
  "case_desvios",
  {
    case_id: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    tenant_id: uuid("tenant_id").notNull(),
    regla: text("regla").notNull(),
    ancla: timestamp("ancla", { withTimezone: true, mode: "string" }).notNull(),
    dato: text("dato"),
    detectado_en: timestamp("detectado_en", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.case_id, t.regla, t.ancla] })],
);

export const outboundMessages = pgTable("outbound_messages", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  case_id: uuid("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  template: text("template").notNull(),
  rendered_body: text("rendered_body").notNull(),
  status: text("status").notNull().default("queued"),
  /**
   * The field and document keys this message asked for.
   *
   * The composer rewrites the prose every time, so two messages asking for the
   * same thing look nothing alike. These keys are what lets the next round see
   * it has already asked exactly this and stay quiet.
   */
  asked_keys: text("asked_keys").array(),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  // Intentionally NOT an FK in SQL (allows logging tenant delete events).
  tenant_id: uuid("tenant_id").notNull(),
  actor_id: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  event_type: text("event_type").notNull(),
  target_type: text("target_type"),
  target_id: text("target_id"),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  ip: inet("ip"),
  ua: text("ua"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const aiUsage = pgTable("ai_usage", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  // Intentionally NOT an FK in SQL.
  tenant_id: uuid("tenant_id").notNull(),
  user_id: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  model: text("model").notNull(),
  prompt_tokens: integer("prompt_tokens").notNull().default(0),
  completion_tokens: integer("completion_tokens").notNull().default(0),
  cost_usd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

/**
 * El uso de IA sumado por mes (0046), mantenido por el trigger de `ai_usage`.
 * Lo lee el tablero de métricas; `claimmix_app` no lo puede escribir. `mes` es el
 * primer día del mes en hora argentina y `user_id` es nulo si el usuario se borró.
 */
export const aiUsageMensual = pgTable(
  "ai_usage_mensual",
  {
    tenant_id: uuid("tenant_id").notNull(),
    mes: date("mes", { mode: "string" }).notNull(),
    user_id: uuid("user_id"),
    model: text("model").notNull(),
    calls: bigint("calls", { mode: "number" }).notNull().default(0),
    prompt_tokens: bigint("prompt_tokens", { mode: "number" }).notNull().default(0),
    completion_tokens: bigint("completion_tokens", { mode: "number" }).notNull().default(0),
    cost_usd: numeric("cost_usd").notNull().default("0"),
  },
  (t) => [unique("ai_usage_mensual_clave").on(t.tenant_id, t.mes, t.user_id, t.model).nullsNotDistinct()],
);

export const requiredDocsConfig = pgTable(
  "required_docs_config",
  {
    claim_type: text("claim_type").notNull(),
    doc_key: text("doc_key").notNull(),
    label_es: text("label_es").notNull(),
    required: boolean("required").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.claim_type, t.doc_key] })],
);

/**
 * Entrega al Core por aseguradora (0036). El secreto de firma va cifrado y de
 * la clave de /api/v1 sólo se guarda el sha256; ninguno sale de acá en claro.
 */
export const coreSyncSettings = pgTable("core_sync_settings", {
  tenant_id: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  webhook_url: text("webhook_url"),
  signing_secret_enc: text("signing_secret_enc"),
  enabled: boolean("enabled").notNull().default(false),
  api_key_hash: text("api_key_hash"),
  api_key_prefix: text("api_key_prefix"),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_by: uuid("updated_by"),
});

/**
 * El enlace público del formulario web de cada inquilino (0044). El slug es
 * propio y nunca el id interno; sin DELETE para `claimmix_app`.
 */
export const formularioWeb = pgTable("formulario_web", {
  tenant_id: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  activo: boolean("activo").notNull().default(false),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_by: uuid("updated_by"),
});

/**
 * El IdP OIDC de la empresa de cada inquilino (0045). El secreto va cifrado y no
 * sale de acá en claro; el dominio sólo vale con `dominio_verificado_en`.
 */
export const ssoSettings = pgTable("sso_settings", {
  tenant_id: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  issuer: text("issuer"),
  client_id: text("client_id"),
  client_secret_cifrado: text("client_secret_cifrado"),
  dominio: text("dominio"),
  dominio_verificado_en: timestamp("dominio_verificado_en", { withTimezone: true, mode: "string" }),
  activo: boolean("activo").notNull().default(false),
  exigir: boolean("exigir").notNull().default(false),
  creado_en: timestamp("creado_en", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  actualizado_en: timestamp("actualizado_en", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

/**
 * Tipos de siniestro propios de un inquilino (0044): nombre en las dos lenguas y
 * los documentos y datos que pide. La clave puede ser la de un ramo del código:
 * la fila entonces sólo le cambia los documentos (gana la fila) y se guarda sin
 * datos; el nombre y los datos siguen siendo los del código.
 */
export const tenantClaimTypes = pgTable(
  "tenant_claim_types",
  {
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clave: text("clave").notNull(),
    nombre_es: text("nombre_es").notNull(),
    nombre_en: text("nombre_en").notNull(),
    documentos: text("documentos").array().notNull().default(sql`'{}'`),
    datos: text("datos").array().notNull().default(sql`'{}'`),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenant_id, t.clave] })],
);
