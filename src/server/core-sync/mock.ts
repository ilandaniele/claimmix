/**
 * Mock CoreSyncClient — simulates core system integration deterministically.
 *
 * AC17: Used by POST /api/cases/:id/sync-to-core in all environments where
 *       CORE_SYNC_MODE is not set to 'real'.
 *
 * IC7: No real external API. This mock simulates:
 *   - Failure: caseId ends with '0' → returns success=false, errorMessage='Core timeout'.
 *   - Success: all other cases → returns externalId = 'CORE-' + caseId.slice(0,8).toUpperCase().
 *
 * The deterministic failure rule allows integration tests to reliably test
 * both success and failure paths without mocking the client in tests.
 */

import type { ICoreSyncClient, CoreSyncPayload, CoreSyncResult } from "./client";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Simulated network delay in milliseconds. Keeps tests fast. */
const MOCK_DELAY_MS = 10;

/** Prefix for generated external IDs. */
const EXTERNAL_ID_PREFIX = "CORE-";

/** Error message returned for simulated failures. */
const MOCK_FAILURE_MESSAGE = "Core timeout";

// ── MockCoreSyncClient ────────────────────────────────────────────────────────

/**
 * Mock implementation of ICoreSyncClient.
 *
 * Failure condition: caseId ends with '0'.
 * Success: externalId = 'CORE-' + first 8 chars of caseId in uppercase.
 *
 * Simulates a short async delay to match real-world behavior.
 */
export class MockCoreSyncClient implements ICoreSyncClient {
  async syncCase(caseData: CoreSyncPayload): Promise<CoreSyncResult> {
    // Simulate network latency (non-blocking).
    await delay(MOCK_DELAY_MS);

    const { caseId } = caseData;

    // Deterministic failure condition: caseId ends with '0'.
    if (caseId.endsWith("0")) {
      console.info(
        JSON.stringify({
          level: "info",
          service: "claimmix",
          msg: "core_sync.mock_failure",
          case_id: caseId,
        })
      );
      return {
        externalId: "",
        success: false,
        errorMessage: MOCK_FAILURE_MESSAGE,
      };
    }

    // Success path: generate a deterministic external ID.
    const externalId =
      EXTERNAL_ID_PREFIX + caseId.slice(0, 8).toUpperCase();

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "core_sync.mock_success",
        case_id: caseId,
        external_id: externalId,
      })
    );

    return {
      externalId,
      success: true,
    };
  }
}

// ── Helper ────────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
