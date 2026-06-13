/**
 * Row / insert types inferred from the Drizzle schema
 * (source of truth: neon/migrations/0001_init.sql).
 */
import type * as s from "./schema";

// ── Auth (Better Auth) ───────────────────────────────────────────────────────
export type AuthUserRow = typeof s.authUsers.$inferSelect;
export type AuthUserInsert = typeof s.authUsers.$inferInsert;
export type SessionRow = typeof s.sessions.$inferSelect;
export type SessionInsert = typeof s.sessions.$inferInsert;
export type AccountRow = typeof s.accounts.$inferSelect;
export type AccountInsert = typeof s.accounts.$inferInsert;
export type VerificationRow = typeof s.verifications.$inferSelect;
export type VerificationInsert = typeof s.verifications.$inferInsert;

// ── Core ─────────────────────────────────────────────────────────────────────
export type TenantRow = typeof s.tenants.$inferSelect;
export type TenantInsert = typeof s.tenants.$inferInsert;
export type UserRow = typeof s.users.$inferSelect;
export type UserInsert = typeof s.users.$inferInsert;
export type CaseRow = typeof s.cases.$inferSelect;
export type CaseInsert = typeof s.cases.$inferInsert;
export type RawMessageRow = typeof s.rawMessages.$inferSelect;
export type RawMessageInsert = typeof s.rawMessages.$inferInsert;
export type ExtractedFieldRow = typeof s.extractedFields.$inferSelect;
export type ExtractedFieldInsert = typeof s.extractedFields.$inferInsert;
export type MissingDocRow = typeof s.missingDocs.$inferSelect;
export type MissingDocInsert = typeof s.missingDocs.$inferInsert;
export type OutboundMessageRow = typeof s.outboundMessages.$inferSelect;
export type OutboundMessageInsert = typeof s.outboundMessages.$inferInsert;
export type AuditLogRow = Omit<typeof s.auditLog.$inferSelect, "payload"> & {
  payload: Record<string, unknown>;
};
export type AuditLogInsert = typeof s.auditLog.$inferInsert;
export type AiUsageRow = typeof s.aiUsage.$inferSelect;
export type AiUsageInsert = typeof s.aiUsage.$inferInsert;
export type RequiredDocsConfigRow = typeof s.requiredDocsConfig.$inferSelect;
export type RequiredDocsConfigInsert = typeof s.requiredDocsConfig.$inferInsert;

// ── CRM ──────────────────────────────────────────────────────────────────────
export type CustomerRow = typeof s.customers.$inferSelect;
export type CustomerInsert = typeof s.customers.$inferInsert;
export type CustomerContactRow = typeof s.customerContacts.$inferSelect;
export type CustomerContactInsert = typeof s.customerContacts.$inferInsert;
export type PolicyRow = typeof s.policies.$inferSelect;
export type PolicyInsert = typeof s.policies.$inferInsert;
export type InsuredAssetRow = typeof s.insuredAssets.$inferSelect;
export type InsuredAssetInsert = typeof s.insuredAssets.$inferInsert;

// ── Claims ───────────────────────────────────────────────────────────────────
export type ClaimMessageRow = typeof s.claimMessages.$inferSelect;
export type ClaimMessageInsert = typeof s.claimMessages.$inferInsert;
export type ClaimAttachmentRow = typeof s.claimAttachments.$inferSelect;
export type ClaimAttachmentInsert = typeof s.claimAttachments.$inferInsert;
export type ClaimFieldConfirmationRow = typeof s.claimFieldConfirmations.$inferSelect;
export type ClaimFieldConfirmationInsert = typeof s.claimFieldConfirmations.$inferInsert;
export type ClaimMemoryRow = typeof s.claimMemory.$inferSelect;
export type ClaimMemoryInsert = typeof s.claimMemory.$inferInsert;
export type KnownClaimPatternRow = typeof s.knownClaimPatterns.$inferSelect;
export type KnownClaimPatternInsert = typeof s.knownClaimPatterns.$inferInsert;

// ── Email ────────────────────────────────────────────────────────────────────
export type GmailPollStateRow = typeof s.gmailPollState.$inferSelect;
export type GmailPollStateInsert = typeof s.gmailPollState.$inferInsert;
export type GmailAccountRow = typeof s.gmailAccounts.$inferSelect;
export type GmailAccountInsert = typeof s.gmailAccounts.$inferInsert;

// ── Agents ───────────────────────────────────────────────────────────────────
export type AgentTrainingRow = typeof s.agentTraining.$inferSelect;
export type AgentTrainingInsert = typeof s.agentTraining.$inferInsert;
export type PromptVersionRow = typeof s.promptVersions.$inferSelect;
export type PromptVersionInsert = typeof s.promptVersions.$inferInsert;
export type AgentRunRow = typeof s.agentRuns.$inferSelect;
export type AgentRunInsert = typeof s.agentRuns.$inferInsert;
export type TrainingExampleRow = typeof s.trainingExamples.$inferSelect;
export type TrainingExampleInsert = typeof s.trainingExamples.$inferInsert;
export type AgentFeedbackRow = typeof s.agentFeedback.$inferSelect;
export type AgentFeedbackInsert = typeof s.agentFeedback.$inferInsert;
export type AgentPromptRuleRow = typeof s.agentPromptRules.$inferSelect;
export type AgentPromptRuleInsert = typeof s.agentPromptRules.$inferInsert;
export type ModelTrainingJobRow = typeof s.modelTrainingJobs.$inferSelect;
export type ModelTrainingJobInsert = typeof s.modelTrainingJobs.$inferInsert;
export type TenantAiSettingsRow = typeof s.tenantAiSettings.$inferSelect;
export type TenantAiSettingsInsert = typeof s.tenantAiSettings.$inferInsert;

// ── Shared unions ────────────────────────────────────────────────────────────
export type UserRole = "owner" | "admin" | "specialist" | "analyst" | "viewer";
