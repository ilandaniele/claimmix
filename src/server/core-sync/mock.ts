/**
 * Mock CoreSyncClient — simulates core system integration deterministically.
 *
 * AC17: Used by POST /api/cases/:id/sync-to-core only when CORE_SYNC_MODE=mock
 *       (tests and the demo). Otherwise the tenant's webhook in
 *       `core_sync_settings` gets the case (`RealCoreSyncClient`), or, with the
 *       delivery off or incomplete, there is no client: see `getCoreSyncClient`.
 *
 * This mock never leaves the process. It simulates:
 *   - Failure: caseId ends with '0' → returns ok=false, motivo='timeout'.
 *   - Success: all other cases → returns externalId = 'CORE-' + caseId.slice(0,8).toUpperCase().
 *
 * The deterministic failure rule allows integration tests to reliably test
 * both success and failure paths without mocking the client in tests.
 */

import type { ICoreSyncClient, CoreSyncPayload, CoreSyncResult } from "./client";
import { logger } from "@/lib/observability/logger";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Simulated network delay in milliseconds. Keeps tests fast. */
const MOCK_DELAY_MS = 10;

/** Prefix for generated external IDs. */
const EXTERNAL_ID_PREFIX = "CORE-";

/** Motivo de la falla simulada: el mismo código que da el cliente real. */
const MOCK_FAILURE_MOTIVO = "timeout";

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
      logger.info({
        case_id: caseId,
      }, "core_sync.mock_failure");
      return { ok: false, motivo: MOCK_FAILURE_MOTIVO };
    }

    // Success path: generate a deterministic external ID.
    const externalId =
      EXTERNAL_ID_PREFIX + caseId.slice(0, 8).toUpperCase();

    logger.info({
        case_id: caseId,
        external_id: externalId,
      }, "core_sync.mock_success");

    return { ok: true, externalId };
  }
}

// ── Helper ────────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
