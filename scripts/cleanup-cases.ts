/**
 * scripts/cleanup-cases.ts
 *
 * DEV UTILITY — deletes all cases (and dependent rows) for a configured tenant.
 *
 * Usage:
 *   pnpm cleanup:cases
 *
 * Required env vars (loaded from .env.local):
 *   DATABASE_URL    — Neon/Postgres connection string
 *   GMAIL_TENANT_ID — tenant whose cases will be deleted
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
 * NEVER runs against production without explicit "DELETE" confirmation.
 */

import * as readline from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs";
import { neon } from "@neondatabase/serverless";
import * as dotenv from "dotenv";

// ---------------------------------------------------------------------------
// Load .env.local — must be done before reading process.env
// ---------------------------------------------------------------------------
function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }
}

// ---------------------------------------------------------------------------
// Validation — exits with code 1 on any missing required variable
// ---------------------------------------------------------------------------
export interface EnvConfig {
  databaseUrl: string;
  tenantId: string;
}

export function validateEnv(): EnvConfig {
  const databaseUrl = process.env["DATABASE_URL"];
  const tenantId = process.env["GMAIL_TENANT_ID"];

  const missing: string[] = [];
  if (!databaseUrl) missing.push("DATABASE_URL");
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
    databaseUrl: databaseUrl!,
    tenantId: tenantId!,
  };
}

// ---------------------------------------------------------------------------
// Prompt helper
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
// Main orchestration function
// ---------------------------------------------------------------------------
export async function run(
  env: EnvConfig,
  deps: {
    databaseUrl: string;
    prompt: (question: string) => Promise<string>;
    log: (msg: string) => void;
  }
): Promise<void> {
  const { prompt, log } = deps;
  const { tenantId } = env;
  const sql = neon(deps.databaseUrl);

  // Count before delete
  const countRows = await sql`SELECT COUNT(*) AS count FROM cases WHERE tenant_id = ${tenantId}`;
  const caseCount = Number((countRows[0] as Record<string, unknown>)?.["count"] ?? 0);

  log(`\nAbout to delete ${caseCount} cases for tenant ${tenantId}.`);
  log(`This cannot be undone.\n`);

  const answer = await prompt(`Type DELETE to confirm: `);

  if (answer !== "DELETE") {
    log("Cancelled.");
    return;
  }

  log("\nDeleting...");

  const tables: [string, ReturnType<typeof neon>][] = [];
  void tables; // tables not used — inline deletes below

  // Delete in order: children first, parent last
  const steps: Array<{ name: string; query: () => Promise<unknown[]> }> = [
    { name: "audit_log",                 query: () => sql`DELETE FROM audit_log WHERE tenant_id = ${tenantId} RETURNING id` },
    { name: "claim_messages",            query: () => sql`DELETE FROM claim_messages WHERE tenant_id = ${tenantId} RETURNING id` },
    { name: "claim_attachments",         query: () => sql`DELETE FROM claim_attachments WHERE tenant_id = ${tenantId} RETURNING id` },
    { name: "claim_field_confirmations", query: () => sql`DELETE FROM claim_field_confirmations WHERE tenant_id = ${tenantId} RETURNING id` },
    { name: "missing_docs",              query: () => sql`DELETE FROM missing_docs WHERE tenant_id = ${tenantId} RETURNING id` },
    { name: "extracted_fields",          query: () => sql`DELETE FROM extracted_fields WHERE tenant_id = ${tenantId} RETURNING id` },
    { name: "raw_messages",              query: () => sql`DELETE FROM raw_messages WHERE tenant_id = ${tenantId} RETURNING id` },
    { name: "outbound_messages",         query: () => sql`DELETE FROM outbound_messages WHERE tenant_id = ${tenantId} RETURNING id` },
    { name: "ai_usage",                  query: () => sql`DELETE FROM ai_usage WHERE tenant_id = ${tenantId} RETURNING id` },
    { name: "cases",                     query: () => sql`DELETE FROM cases WHERE tenant_id = ${tenantId} RETURNING id` },
  ];

  for (const step of steps) {
    const rows = await step.query();
    log(`  ${step.name}: ${(rows as unknown[]).length} rows deleted`);
  }

  log("\nCleanup complete.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("cleanup-cases.ts")) {
  loadEnv();
  const env = validateEnv();

  run(env, {
    databaseUrl: env.databaseUrl,
    prompt: promptUser,
    log: console.log,
  }).catch((err: unknown) => {
    console.error("[cleanup-cases] Unexpected error:", err);
    process.exit(1);
  });
}
