import "server-only";

import { and, eq, gte, lt, lte, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { cases } from "@/lib/db/schema";

const DEFAULT_SIMULATE_WORKER_DELAY_MS =
  process.env.NODE_ENV === "test" ? 0 : 5_000;
const DEFAULT_SIMULATE_WORKER_MAX_DELAY_MS = 120_000;
const DEFAULT_SIMULATE_WORKER_LOOKBACK_MS = 15 * 60_000;

function numberEnv(name: string, fallback: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

export function getSimulateWorkerDelayStepMs(): number {
  return numberEnv(
    "SIMULATE_WORKER_DELAY_MS",
    DEFAULT_SIMULATE_WORKER_DELAY_MS,
    60_000
  );
}

export function getSimulateWorkerMaxDelayMs(): number {
  return numberEnv(
    "SIMULATE_WORKER_MAX_DELAY_MS",
    DEFAULT_SIMULATE_WORKER_MAX_DELAY_MS,
    10 * 60_000
  );
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getSimulationWorkerDelayMs(input: {
  tenantId: string;
  caseId: string;
  caseCreatedAt?: string | null;
}): Promise<number> {
  const stepMs = getSimulateWorkerDelayStepMs();
  if (stepMs <= 0 || !input.caseCreatedAt) return 0;

  const createdAtMs = Date.parse(input.caseCreatedAt);
  if (!Number.isFinite(createdAtMs)) return 0;

  const lookbackMs = numberEnv(
    "SIMULATE_WORKER_LOOKBACK_MS",
    DEFAULT_SIMULATE_WORKER_LOOKBACK_MS,
    60 * 60_000
  );
  const lookbackStart = new Date(createdAtMs - lookbackMs).toISOString();

  try {
    const row = firstRow(
      await db
        .select({ queued_count: sql<number>`count(*)::int` })
        .from(cases)
        .where(
          and(
            eq(cases.tenant_id, input.tenantId),
            eq(cases.channel, "email_sim"),
            gte(cases.created_at, lookbackStart),
            or(
              lt(cases.created_at, input.caseCreatedAt),
              and(eq(cases.created_at, input.caseCreatedAt), lte(cases.id, input.caseId))
            )
          )
        )
    );

    const queuedCount = Number(row?.queued_count ?? 1);
    const queuedAhead = Math.max(0, queuedCount - 1);
    return Math.min(queuedAhead * stepMs, getSimulateWorkerMaxDelayMs());
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "unknown";
    console.error("[intake/simulate] throttle lookup failed:", code);
    return 0;
  }
}
