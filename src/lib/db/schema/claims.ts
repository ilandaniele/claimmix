/**
 * Claim-detail tables: claim_messages, claim_attachments,
 * claim_field_confirmations, claim_memory, known_claim_patterns.
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
  boolean,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { cases, tenants, users } from "./core";

export const claimMessages = pgTable("claim_messages", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  case_id: uuid("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  direction: text("direction").notNull(),
  provider: text("provider").notNull().default("postmark"),
  provider_message_id: text("provider_message_id"),
  thread_id: text("thread_id"),
  in_reply_to: text("in_reply_to"),
  from_addr: text("from_addr"),
  to_addr: text("to_addr"),
  subject: text("subject"),
  body_text: text("body_text"),
  body_html: text("body_html"),
  headers: jsonb("headers").notNull().default(sql`'[]'::jsonb`),
  raw_payload: jsonb("raw_payload"),
  template: text("template"),
  status: text("status").notNull(),
  error_code: text("error_code"),
  received_at: timestamp("received_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  sent_at: timestamp("sent_at", { withTimezone: true, mode: "string" }),
});

export const claimAttachments = pgTable("claim_attachments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  case_id: uuid("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  file_name: text("file_name").notNull(),
  content_type: text("content_type").notNull(),
  size_bytes: integer("size_bytes").notNull(),
  external_url: text("external_url"),
  storage_path: text("storage_path"),
  content_hash: text("content_hash"),
  source_message_id: text("source_message_id"),
  claim_message_id: uuid("claim_message_id").references(() => claimMessages.id, {
    onDelete: "cascade",
  }),
  rejected_reason: text("rejected_reason"),
  /**
   * Qué documento cerró este adjunto, si cerró alguno.
   *
   * `unmatchedAttachments` se llama así y devolvía TODOS los adjuntos del caso,
   * porque no había dónde guardar cuál ya había coincidido. Con eso, cada
   * mensaje nuevo volvía a ofrecerle al modelo las fotos viejas para tapar los
   * documentos que faltan.
   *
   * Nullable a propósito: las filas que ya existen no saben qué cerraron y nadie
   * puede reconstruirlo. Un adjunto sin marca se sigue ofreciendo, que es el
   * comportamiento de siempre.
   */
  matched_doc_key: text("matched_doc_key"),
});

export const claimFieldConfirmations = pgTable("claim_field_confirmations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  case_id: uuid("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  field_name: text("field_name").notNull(),
  suggested_value: text("suggested_value"),
  conflict_with_value: text("conflict_with_value"),
  confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull(),
  status: text("status").notNull().default("pending"),
  confirmed_by: uuid("confirmed_by").references(() => users.id, {
    onDelete: "set null",
  }),
  confirmed_at: timestamp("confirmed_at", { withTimezone: true, mode: "string" }),
  notes: text("notes"),
});

export const claimMemory = pgTable("claim_memory", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  memory_type: text("memory_type").notNull().default("sender_profile"),
  key: text("key").notNull(),
  value: jsonb("value").notNull().default(sql`'{}'::jsonb`),
  confidence: doublePrecision("confidence"),
  source: text("source"),
  last_used_at: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
  use_count: integer("use_count").notNull().default(0),
});

export const knownClaimPatterns = pgTable("known_claim_patterns", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  // NULL = global pattern (visible to all tenants — app-layer rule).
  tenant_id: uuid("tenant_id").references(() => tenants.id, {
    onDelete: "cascade",
  }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  pattern_text: text("pattern_text").notNull(),
  pattern_type: text("pattern_type").notNull().default("keyword"),
  claim_type: text("claim_type"),
  severity_hint: text("severity_hint"),
  language: text("language").notNull().default("es-AR"),
  enabled: boolean("enabled").notNull().default(true),
});
