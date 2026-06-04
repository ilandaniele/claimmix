/**
 * scripts/cleanup-cases.ts
 *
 * DEV UTILITY — deletes all cases (and dependent rows) for a configured tenant.
 * Uses the Supabase service-role key to bypass RLS.
 *
 * Usage:
 *   pnpm cleanup:cases
 *
 * Required env vars (loaded from .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL   — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  — service-role key (bypasses RLS)
 *   GMAIL_TENANT_ID            — tenant whose cases will be deleted
 *
 * Deletion order (child tables first, parent last):
 *   1. audit_log               (tenant-scoped; no FK to cases)
 *   2. claim_messages          (FK → cases ON DELETE CASCADE)
 *   3. claim_attachments       (FK → cases ON DELETE CASCADE)
 *   4. claim_field_confirmations (FK → cases ON DELETE CASCADE)
 *   5. missing_docs            (FK → cases ON DELETE CASCADE)
 *   6. extracted_fields        (FK → cases ON DELETE CASCADE)
 *   7. raw_messages            (FK → cases ON DELETE CASCADE)
 *   8. outbound_messages       (FK → cases ON DELETE CASCADE)
 *   9. ai_usage                (tenant-scoped; no FK to cases)
 *  10. cases                   (root)
 *
 * Note: tables with ON DELETE CASCADE on case_id would be handled automatically
 * when deleting from cases, but we delete them explicitly to print per-table counts
 * and to give the operator visibility into what is being removed.
 *
 * NEVER runs against production without explicit "DELETE" confirmation.
 */

import * as readline from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";

// ---------------------------------------------------------------------------
// Load .env.local — must be done before reading process.env
// ---------------------------------------------------------------------------
function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    // Fall back to .env if .env.local is absent (CI / Docker usage)
    dotenv.config();
  }
}

// ---------------------------------------------------------------------------
// Validation — exits with code 1 on any missing required variable
// ---------------------------------------------------------------------------
export interface EnvConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  tenantId: string;
}

export function validateEnv(): EnvConfig {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  const tenantId = process.env["GMAIL_TENANT_ID"];

  const missing: string[] = [];
  if (!supabaseUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!tenantId) missing.push("GMAIL_TENANT_ID");

  if (missing.length > 0) {
    console.error(
      `[cleanup-cases] ERROR: Missing required environment variables:\n` +
        missing.map((v) => `  - ${v}`).join("\n") +
        `\nEnsure these are set in .env.local before running this script.`
    );
    process.exit(1);
  }

  return {
    supabaseUrl: supabaseUrl!,
    serviceRoleKey: serviceRoleKey!,
    tenantId: tenantId!,
  };
}

// ---------------------------------------------------------------------------
// Deletion order — child tables first, parent (cases) last
// Entries that are tenant-scoped without a FK to cases are cleaned too
// so the tenant workspace is fully reset.
// ---------------------------------------------------------------------------
export interface DeletionTable {
  table: string;
  filter: "tenant_id" | "case_id_via_tenant";
}

// All tables use tenant_id filter for explicit, safe, tenant-scoped deletion.
export const DELETION_ORDER: readonly DeletionTable[] = [
  { table: "audit_log", filter: "tenant_id" },
  { table: "claim_messages", filter: "tenant_id" },
  { table: "claim_attachments", filter: "tenant_id" },
  { table: "claim_field_confirmations", filter: "tenant_id" },
  { table: "missing_docs", filter: "tenant_id" },
  { table: "extracted_fields", filter: "tenant_id" },
  { table: "raw_messages", filter: "tenant_id" },
  { table: "outbound_messages", filter: "tenant_id" },
  { table: "ai_usage", filter: "tenant_id" },
  { table: "cases", filter: "tenant_id" },
] as const;

// ---------------------------------------------------------------------------
// Count helper
// ---------------------------------------------------------------------------
export async function countCases(
  supabase: SupabaseClient,
  tenantId: string
): Promise<number> {
  const { count, error } = await supabase
    .from("cases")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);

  if (error) {
    console.error(`[cleanup-cases] Failed to count cases: ${error.message}`);
    process.exit(1);
  }

  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Delete a single table — returns row count deleted
// ---------------------------------------------------------------------------
export async function deleteFromTable(
  supabase: SupabaseClient,
  tableName: string,
  tenantId: string
): Promise<number> {
  const { data, error } = await supabase
    .from(tableName)
    .delete()
    .eq("tenant_id", tenantId)
    .select("*");

  if (error) {
    console.error(
      `[cleanup-cases] Failed to delete from ${tableName}: ${error.message}`
    );
    process.exit(1);
  }

  return data?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Prompt helper — wraps readline for testability
// ---------------------------------------------------------------------------
export function promptUser(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ---------------------------------------------------------------------------
// Main orchestration function — exported for testing
// ---------------------------------------------------------------------------
export async function run(
  env: EnvConfig,
  deps: {
    supabase: SupabaseClient;
    prompt: (question: string) => Promise<string>;
    log: (msg: string) => void;
  }
): Promise<void> {
  const { supabase, prompt, log } = deps;
  const { tenantId } = env;

  // Count cases for this tenant
  const caseCount = await countCases(supabase, tenantId);

  log(`\nAbout to delete ${caseCount} cases for tenant ${tenantId}.`);
  log(`This cannot be undone.\n`);

  const answer = await prompt(`Type DELETE to confirm: `);

  if (answer !== "DELETE") {
    log("Cancelled.");
    return;
  }

  log("\nDeleting...");

  for (const entry of DELETION_ORDER) {
    const deleted = await deleteFromTable(supabase, entry.table, tenantId);
    log(`  ${entry.table}: ${deleted} rows deleted`);
  }

  log("\nCleanup complete.");
}

// ---------------------------------------------------------------------------
// Entry point — only executed when run directly (not imported in tests)
// ---------------------------------------------------------------------------
// Vitest runs the file in a module context, so we guard on import.meta.url.
// `tsx` sets import.meta.url to the file path; we compare to argv[1].
if (process.argv[1] && process.argv[1].endsWith("cleanup-cases.ts")) {
  loadEnv();
  const env = validateEnv();

  const supabase = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false },
  });

  run(env, {
    supabase,
    prompt: promptUser,
    log: console.log,
  }).catch((err: unknown) => {
    console.error("[cleanup-cases] Unexpected error:", err);
    process.exit(1);
  });
}
