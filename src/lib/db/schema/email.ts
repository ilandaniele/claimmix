/**
 * Email intake tables: gmail_poll_state, gmail_accounts.
 *
 * Source of truth: neon/migrations/0001_init.sql. These TS definitions are for
 * query building / type inference only — CHECK constraints, indexes and
 * triggers live in the SQL migration and are intentionally not declared here.
 *
 * NOTE: property keys are intentionally IDENTICAL to the snake_case column
 * names to preserve existing JSON response shapes.
 */
import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenants, users } from "./core";

export const gmailPollState = pgTable("gmail_poll_state", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  gmail_account_email: text("gmail_account_email").notNull(),
  history_id: text("history_id").notNull().default("1"),
  last_polled_at: timestamp("last_polled_at", { withTimezone: true, mode: "string" }),
  last_error: text("last_error"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  watch_expiration: timestamp("watch_expiration", {
    withTimezone: true,
    mode: "string",
  }),
  watch_history_id: text("watch_history_id"),
});

export const gmailAccounts = pgTable("gmail_accounts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  refresh_token_encrypted: text("refresh_token_encrypted").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  connected_by: uuid("connected_by").references(() => users.id, {
    onDelete: "set null",
  }),
  last_connected_at: timestamp("last_connected_at", {
    withTimezone: true,
    mode: "string",
  }),
  last_error: text("last_error"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }),
});
