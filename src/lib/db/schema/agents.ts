/**
 * Agent learning tables: agent_training, prompt_versions, agent_runs,
 * training_examples, agent_feedback, agent_prompt_rules, model_training_jobs,
 * tenant_ai_settings.
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
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { claimMessages } from "./claims";
import { cases, tenants, users } from "./core";

export const agentTraining = pgTable("agent_training", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  title: text("title").notNull().default("Email intake agent training"),
  content: text("content").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  updated_by: uuid("updated_by").references(() => users.id, {
    onDelete: "set null",
  }),
});

export const promptVersions = pgTable("prompt_versions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  system_prompt: text("system_prompt").notNull().default(""),
  active: boolean("active").notNull().default(false),
  created_by: uuid("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  case_id: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),
  claim_message_id: uuid("claim_message_id").references(() => claimMessages.id, {
    onDelete: "set null",
  }),
  provider_message_id: text("provider_message_id"),
  model_provider: text("model_provider").notNull().default("openai"),
  model_name: text("model_name").notNull(),
  prompt_version_id: uuid("prompt_version_id").references(() => promptVersions.id, {
    onDelete: "set null",
  }),
  prompt_version: text("prompt_version").notNull().default("builtin-v1"),
  input_payload: jsonb("input_payload").notNull().default(sql`'{}'::jsonb`),
  output_payload: jsonb("output_payload").notNull().default(sql`'{}'::jsonb`),
  confidence_payload: jsonb("confidence_payload").notNull().default(sql`'{}'::jsonb`),
  missing_fields: jsonb("missing_fields").notNull().default(sql`'[]'::jsonb`),
  is_trainable_suggestion: boolean("is_trainable_suggestion").notNull().default(false),
  trainability_score: numeric("trainability_score", { precision: 4, scale: 3 })
    .notNull()
    .default("0"),
  trainability_reasons: jsonb("trainability_reasons").notNull().default(sql`'[]'::jsonb`),
  blocking_reasons: jsonb("blocking_reasons").notNull().default(sql`'[]'::jsonb`),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const trainingExamples = pgTable("training_examples", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  agent_run_id: uuid("agent_run_id")
    .notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  case_id: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),
  claim_message_id: uuid("claim_message_id").references(() => claimMessages.id, {
    onDelete: "set null",
  }),
  claim_type: text("claim_type"),
  input_payload: jsonb("input_payload").notNull().default(sql`'{}'::jsonb`),
  expected_output: jsonb("expected_output").notNull().default(sql`'{}'::jsonb`),
  status: text("status").notNull().default("approved"),
  approved_by: uuid("approved_by").references(() => users.id, {
    onDelete: "set null",
  }),
  approved_at: timestamp("approved_at", { withTimezone: true, mode: "string" }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const agentFeedback = pgTable("agent_feedback", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  agent_run_id: uuid("agent_run_id")
    .notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  reviewer_id: uuid("reviewer_id").references(() => users.id, {
    onDelete: "set null",
  }),
  original_output: jsonb("original_output").notNull().default(sql`'{}'::jsonb`),
  corrected_output: jsonb("corrected_output").notNull().default(sql`'{}'::jsonb`),
  feedback_type: text("feedback_type").notNull().default("correction"),
  approved_for_training: boolean("approved_for_training").notNull().default(false),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const agentPromptRules = pgTable("agent_prompt_rules", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  rule_text: text("rule_text").notNull(),
  rule_type: text("rule_type").notNull().default("extraction"),
  active: boolean("active").notNull().default(true),
  created_by: uuid("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }),
});

export const modelTrainingJobs = pgTable("model_training_jobs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("draft"),
  provider: text("provider").notNull().default("openai"),
  base_model: text("base_model").notNull().default(""),
  fine_tuned_model_id: text("fine_tuned_model_id"),
  training_example_count: integer("training_example_count").notNull().default(0),
  eval_result: jsonb("eval_result"),
  created_by: uuid("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  completed_at: timestamp("completed_at", { withTimezone: true, mode: "string" }),
});

export const tenantAiSettings = pgTable("tenant_ai_settings", {
  tenant_id: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("openai"),
  gemini_api_key_encrypted: text("gemini_api_key_encrypted"),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});
