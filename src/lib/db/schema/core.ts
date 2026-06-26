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
  bigserial,
  boolean,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { authUsers } from "./auth";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
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
  // Granular injury severity (migration 0009)
  injury_severity: text("injury_severity"),
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
});

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
