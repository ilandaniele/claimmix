/**
 * Provider usage event logger.
 *
 * Records every AI provider call (success or failure) to provider_usage_events
 * for quota visibility, rate-limit tracking, and latency monitoring.
 * Non-fatal — all errors are swallowed so callers are never blocked.
 * No PII is stored.
 */

import "server-only";
import { db, tables } from "@/lib/db";
import { enTenant } from "@/data/scope";

export interface UsageEventInput {
  tenantId: string;
  provider: string;
  model: string;
  operation?: string;
  status: "success" | "error" | "rate_limited" | "quota_exceeded" | "invalid_json" | "timeout";
  latencyMs?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  retryCount?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export async function logProviderUsage(event: UsageEventInput): Promise<void> {
  try {
    await enTenant({ tenantId: event.tenantId }, (db) =>
      db.insert(tables.providerUsageEvents).values({
        tenant_id: event.tenantId,
        provider: event.provider,
        model: event.model,
        operation: event.operation ?? "extraction",
        status: event.status,
        latency_ms: event.latencyMs ?? null,
        error_code: event.errorCode ?? null,
        error_message: event.errorMessage
          ? event.errorMessage.slice(0, 500)
          : null,
        retry_count: event.retryCount ?? 0,
        prompt_tokens: event.promptTokens ?? 0,
        completion_tokens: event.completionTokens ?? 0,
      })
    );
  } catch {
    // Non-fatal — usage logging must never block extraction.
  }
}
