/**
 * CRM tables: customers, customer_contacts, policies, insured_assets.
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
  date,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "./core";

export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  full_name: text("full_name").notNull(),
  email: text("email"),
  dni: text("dni"),
  phone: text("phone"),
  birth_date: date("birth_date"),
  address: text("address"),
  notes: text("notes"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }),
});

export const customerContacts = pgTable("customer_contacts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  customer_id: uuid("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  contact_type: text("contact_type").notNull(),
  value: text("value").notNull(),
  is_primary: boolean("is_primary").notNull().default(false),
  verified_at: timestamp("verified_at", { withTimezone: true, mode: "string" }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const policies = pgTable("policies", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  customer_id: uuid("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  policy_number: text("policy_number").notNull(),
  policy_type: text("policy_type").notNull().default("auto"),
  status: text("status").notNull().default("active"),
  start_date: date("start_date"),
  end_date: date("end_date"),
  premium_amount: numeric("premium_amount", { precision: 12, scale: 2 }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }),
});

export const insuredAssets = pgTable("insured_assets", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant_id: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  policy_id: uuid("policy_id")
    .notNull()
    .references(() => policies.id, { onDelete: "cascade" }),
  asset_type: text("asset_type").notNull(),
  make: text("make"),
  model: text("model"),
  year: smallint("year"),
  plate: text("plate"),
  vin: text("vin"),
  description: text("description"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});
