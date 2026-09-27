/**
 * Row / insert types inferred from the Drizzle schema
 * (source of truth: neon/migrations/0001_init.sql).
 */
import type * as s from "./schema";

// ── Core ─────────────────────────────────────────────────────────────────────
export type UserRow = typeof s.users.$inferSelect;
export type CaseRow = typeof s.cases.$inferSelect;
export type CaseInsert = typeof s.cases.$inferInsert;
export type ExtractedFieldRow = typeof s.extractedFields.$inferSelect;
export type MissingDocRow = typeof s.missingDocs.$inferSelect;
export type AuditLogRow = Omit<typeof s.auditLog.$inferSelect, "payload"> & {
  payload: Record<string, unknown>;
};
export type AuditLogInsert = typeof s.auditLog.$inferInsert;
