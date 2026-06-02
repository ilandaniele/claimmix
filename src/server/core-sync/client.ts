/**
 * CoreSyncService client interface and factory.
 *
 * AC17: CoreSyncService.send() is called by POST /api/cases/:id/sync-to-core.
 *       On success: cases.status='enviado_a_core', cases.core_external_id set.
 *       On failure: cases.status='error_core', cases.core_error_message set.
 *
 * IC7: No real external API exists — only MockCoreSyncClient is implemented.
 *      Set CORE_SYNC_MODE=mock (or leave unset) to use the mock.
 *      Set CORE_SYNC_MODE=real to use a real implementation (not built in this PR).
 *
 * This file defines the interface contract and the factory function.
 * The mock implementation lives in ./mock.ts.
 */

// ── Payload and result types ──────────────────────────────────────────────────

/**
 * Payload sent to the core system when a case is ready for sync.
 *
 * All fields are required by the core system spec.
 * PII note: customerName and policyNumber are PII — only log IDs, never values.
 */
export interface CoreSyncPayload {
  /** UUID of the case in claimmix. */
  caseId: string;
  /** UUID of the tenant. */
  tenantId: string;
  /** Claim type (choque, robo, granizo, incendio, etc.). */
  claimType: string;
  /** Severity level (low, medium, high, critical). */
  severity: string | null;
  /** Full name of the claimant (PII). */
  customerName: string | null;
  /** Policy number (PII). */
  policyNumber: string | null;
  /** Date of the accident (ISO date string or human-readable). */
  accidentDate: string | null;
  /** Description of the accident. */
  accidentDescription: string | null;
  /** Full snapshot of extracted fields as key-value pairs. */
  extractedFields: Record<string, string>;
}

/**
 * Result returned by CoreSyncClient.syncCase().
 *
 * On success: externalId is set, success=true.
 * On failure: success=false, errorMessage explains the failure.
 */
export interface CoreSyncResult {
  /** External ID assigned by the core system (only set on success). */
  externalId: string;
  /** Whether the sync was successful. */
  success: boolean;
  /** Error message if success=false. */
  errorMessage?: string;
}

// ── Interface ─────────────────────────────────────────────────────────────────

/**
 * Contract for core system integration clients.
 *
 * Implementations:
 *   - MockCoreSyncClient (./mock.ts) — simulates success/failure deterministically.
 *   - (Future) RealCoreSyncClient — calls the actual external core API.
 */
export interface ICoreSyncClient {
  syncCase(caseData: CoreSyncPayload): Promise<CoreSyncResult>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

import { MockCoreSyncClient } from "./mock";

/**
 * Return the appropriate CoreSyncClient based on environment configuration.
 *
 * CORE_SYNC_MODE=mock (or unset) → MockCoreSyncClient (default, safe for all environments).
 * CORE_SYNC_MODE=real            → logs warning, falls back to mock (not built in this PR).
 *
 * IC7: Mock is the default and only implementation for this PR.
 */
export function getCoreSyncClient(): ICoreSyncClient {
  const mode = process.env.CORE_SYNC_MODE ?? "mock";

  if (mode === "real") {
    // Real implementation is out of scope for this PR (IC7).
    // Returning the mock with a console warning so a misconfigured prod environment
    // doesn't silently fail — the warning will surface in Vercel logs.
    console.warn(
      "[core-sync] CORE_SYNC_MODE=real is not implemented. Falling back to mock. " +
        "Implement RealCoreSyncClient in src/server/core-sync/real.ts to enable real sync."
    );
  }

  return new MockCoreSyncClient();
}
