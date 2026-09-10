import "server-only";

import { and, eq, gte, lt, lte, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { cases } from "@/lib/db/schema";
import { enTenant } from "@/data/scope";

const DEFAULT_SIMULATE_WORKER_DELAY_MS =
  process.env.NODE_ENV === "test" ? 0 : 5_000;
const DEFAULT_SIMULATE_WORKER_MAX_DELAY_MS = 120_000;
const DEFAULT_SIMULATE_WORKER_LOOKBACK_MS = 15 * 60_000;
const DEFAULT_SIMULATE_WORKER_TURN_POLL_MS =
  process.env.NODE_ENV === "test" ? 0 : 2_000;
const DEFAULT_SIMULATE_WORKER_TURN_MAX_WAIT_MS =
  process.env.NODE_ENV === "test" ? 0 : 170_000;
const DEFAULT_SIMULATE_WORKER_MIN_GAP_MS =
  process.env.NODE_ENV === "test" ? 0 : 1_500;
const DEFAULT_SIMULATE_WORKER_STALE_AFTER_MS = 10 * 60_000;

function numberEnv(name: string, fallback: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

function getSimulateWorkerDelayStepMs(): number {
  return numberEnv(
    "SIMULATE_WORKER_DELAY_MS",
    DEFAULT_SIMULATE_WORKER_DELAY_MS,
    60_000
  );
}

function getSimulateWorkerMaxDelayMs(): number {
  return numberEnv(
    "SIMULATE_WORKER_MAX_DELAY_MS",
    DEFAULT_SIMULATE_WORKER_MAX_DELAY_MS,
    10 * 60_000
  );
}

function getSimulateWorkerTurnPollMs(): number {
  return numberEnv(
    "SIMULATE_WORKER_TURN_POLL_MS",
    DEFAULT_SIMULATE_WORKER_TURN_POLL_MS,
    60_000
  );
}

function getSimulateWorkerTurnMaxWaitMs(): number {
  return numberEnv(
    "SIMULATE_WORKER_TURN_MAX_WAIT_MS",
    DEFAULT_SIMULATE_WORKER_TURN_MAX_WAIT_MS,
    10 * 60_000
  );
}

function getSimulateWorkerMinGapMs(): number {
  return numberEnv(
    "SIMULATE_WORKER_MIN_GAP_MS",
    DEFAULT_SIMULATE_WORKER_MIN_GAP_MS,
    60_000
  );
}

function getSimulateWorkerStaleAfterMs(): number {
  return numberEnv(
    "SIMULATE_WORKER_STALE_AFTER_MS",
    DEFAULT_SIMULATE_WORKER_STALE_AFTER_MS,
    60 * 60_000
  );
}

/*
 * Los lectores de configuración de arriba dejaron de ser públicos.
 *
 * Los siete se exportaban y ninguno se usaba fuera de este archivo. Un export
 * es una promesa —«esto lo llama alguien más, cuidado al cambiarlo»— y siete
 * promesas que nadie cobra hacen que el módulo parezca tener una superficie
 * que no tiene.
 */
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
  // Fijado antes de entrar al armador a propósito: TypeScript ya sabe, por el
  // `return 0` de arriba, que esto no es null — pero ese estrechamiento no
  // cruza el borde de una función flecha, y adentro vuelve a ser `string | null`.
  const desdeCuando = input.caseCreatedAt;

  try {
    const row = firstRow(
      await enTenant({ tenantId: input.tenantId }, (db) =>
        db
          .select({ queued_count: sql<number>`count(*)::int` })
          .from(cases)
          .where(
            and(
              eq(cases.tenant_id, input.tenantId),
              eq(cases.channel, "email_sim"),
              gte(cases.created_at, lookbackStart),
              or(
                lt(cases.created_at, desdeCuando),
                and(eq(cases.created_at, desdeCuando), lte(cases.id, input.caseId))
              )
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

export async function getEarlierPendingSimulationCount(input: {
  tenantId: string;
  caseId: string;
  caseCreatedAt?: string | null;
}): Promise<number> {
  if (!input.caseCreatedAt) return 0;

  const createdAtMs = Date.parse(input.caseCreatedAt);
  if (!Number.isFinite(createdAtMs)) return 0;

  const lookbackMs = numberEnv(
    "SIMULATE_WORKER_LOOKBACK_MS",
    DEFAULT_SIMULATE_WORKER_LOOKBACK_MS,
    60 * 60_000
  );
  const lookbackStart = new Date(createdAtMs - lookbackMs).toISOString();
  // Fijado antes de entrar al armador a propósito: TypeScript ya sabe, por el
  // `return 0` de arriba, que esto no es null — pero ese estrechamiento no
  // cruza el borde de una función flecha, y adentro vuelve a ser `string | null`.
  const desdeCuando = input.caseCreatedAt;
  const staleCutoff = new Date(
    Date.now() - getSimulateWorkerStaleAfterMs()
  ).toISOString();

  try {
    const row = firstRow(
      await enTenant({ tenantId: input.tenantId }, (db) =>
        db
          .select({ queued_count: sql<number>`count(*)::int` })
          .from(cases)
          .where(
            and(
              eq(cases.tenant_id, input.tenantId),
              eq(cases.channel, "email_sim"),
              eq(cases.status, "procesando"),
              gte(cases.created_at, lookbackStart),
              gte(cases.created_at, staleCutoff),
              or(
                lt(cases.created_at, desdeCuando),
                and(eq(cases.created_at, desdeCuando), lt(cases.id, input.caseId))
              )
            )
          )
      )
    );

    return Math.max(0, Number(row?.queued_count ?? 0));
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "unknown";
    console.error("[intake/simulate] queue lookup failed:", code);
    return 0;
  }
}

// ─── Real-email extraction throttle ──────────────────────────────────────────
// Prevents Gemini rate-limit floods when many real emails arrive at once.
// Uses the same DB-polling pattern as the simulation semaphore.

/**
 * Cuanto puede esperar un worker su turno.
 *
 * Era 300.000 ms por defecto, con techo de media hora. La ruta que lo llama
 * —`/api/worker/extract`— tiene `maxDuration: 60` en `vercel.json`. O sea que
 * el que esperaba mas de un minuto no llegaba a existir: la invocacion se moria
 * primero, sin haber llamado a Gemini y sin escribir nada.
 *
 * Esperar mas de lo que dura la funcion no es esperar: es morirse callado. El
 * default y el techo ahora quedan por debajo del presupuesto, con aire para que
 * lo que sigue —la llamada al modelo y las escrituras— entre.
 */
function getEmailWorkerMaxWaitMs(): number {
  return numberEnv("EMAIL_WORKER_MAX_WAIT_MS", 20_000, 40_000);
}

function getEmailWorkerTurnPollMs(): number {
  return numberEnv("EMAIL_WORKER_TURN_POLL_MS", 3_000, 60_000);
}

function getEmailWorkerMinGapMs(): number {
  return numberEnv("EMAIL_WORKER_MIN_GAP_MS", 1_200, 60_000);
}

function getEmailWorkerMaxConcurrency(): number {
  return numberEnv("GEMINI_WORKER_CONCURRENCY", 1, 16);
}

/**
 * Count real-email cases in 'recibido' that were created before this one
 * and are still being processed. These are "blockers" — they hold a Gemini slot.
 */
async function getEarlierPendingEmailCount(input: {
  tenantId: string;
  caseId: string;
  caseCreatedAt?: string | null;
}): Promise<number> {
  if (!input.caseCreatedAt) return 0;
  const createdAtMs = Date.parse(input.caseCreatedAt);
  if (!Number.isFinite(createdAtMs)) return 0;

  const lookbackStart = new Date(createdAtMs - 15 * 60_000).toISOString();
  // Igual que en las otras dos de este archivo: el estrechamiento del
  // `return 0` de arriba no cruza el borde de la función flecha.
  const desdeCuando = input.caseCreatedAt;
  const staleCutoff = new Date(Date.now() - 10 * 60_000).toISOString();

  try {
    const row = firstRow(
      await enTenant({ tenantId: input.tenantId }, (db) =>
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(cases)
          .where(
            and(
              eq(cases.tenant_id, input.tenantId),
              eq(cases.channel, "email"),
              eq(cases.status, "recibido"),
              gte(cases.created_at, lookbackStart),
              gte(cases.created_at, staleCutoff),
              or(
                lt(cases.created_at, desdeCuando),
                and(eq(cases.created_at, desdeCuando), lt(cases.id, input.caseId))
              )
            )
          )
      )
    );
    return Math.max(0, Number(row?.count ?? 0));
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "unknown";
    console.error("[email-throttle] queue lookup failed:", code);
    return 0; // never block on error
  }
}

/**
 * Wait until fewer than GEMINI_WORKER_CONCURRENCY earlier real-email cases are
 * being processed. Enforces FIFO ordering — older emails always get priority.
 * Times out after EMAIL_WORKER_MAX_WAIT_MS (default 20 s, techo 40 s) rather than
 * blocking forever. El techo esta por DEBAJO del maxDuration de 60 s de la ruta:
 * esperar mas de lo que dura la funcion es morirse callado.
 */
export async function waitForEmailExtractionTurn(input: {
  tenantId: string;
  caseId: string;
  caseCreatedAt?: string | null;
}): Promise<{ waitedMs: number; timedOut: boolean; blockers: number }> {
  const startedAt = Date.now();
  const maxWaitMs = getEmailWorkerMaxWaitMs();
  const pollMs = getEmailWorkerTurnPollMs();
  const maxConcurrent = getEmailWorkerMaxConcurrency();

  let blockers = await getEarlierPendingEmailCount(input);
  /** Si hubo cola de verdad. Ver el gap, abajo. */
  let hubo = blockers >= maxConcurrent;

  while (blockers >= maxConcurrent) {
    const elapsed = Date.now() - startedAt;
    if (maxWaitMs <= 0 || elapsed >= maxWaitMs) {
      return { waitedMs: elapsed, timedOut: true, blockers };
    }
    await sleep(Math.min(Math.max(pollMs, 1), maxWaitMs - elapsed));
    blockers = await getEarlierPendingEmailCount(input);
    hubo = true;
  }

  /*
   * El respiro va sólo si hubo de quién separarse.
   *
   * Corría SIEMPRE, incluso con `blockers = 0` y el bucle sin dar una vuelta:
   * un segundo y dos décimas de sueño en cada mail que entra, esperando a
   * nadie. En una casilla tranquila —que es casi todo el tiempo— era el único
   * efecto de esta función.
   *
   * Está para no pegarle a Gemini dos veces seguidas cuando venimos de una
   * cola, no para espaciar contra el vacío. Y el ritmo global contra el
   * proveedor ya lo cuida `GEMINI_MIN_REQUEST_INTERVAL_MS`, que vive en el
   * extractor y sí corre siempre.
   */
  const minGapMs = getEmailWorkerMinGapMs();
  if (hubo && minGapMs > 0) await sleep(minGapMs);

  return { waitedMs: Date.now() - startedAt, timedOut: false, blockers: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────

export async function waitForSimulationTurn(input: {
  tenantId: string;
  caseId: string;
  caseCreatedAt?: string | null;
}): Promise<{ waitedMs: number; timedOut: boolean; blockers: number }> {
  const startedAt = Date.now();
  const maxWaitMs = getSimulateWorkerTurnMaxWaitMs();
  const pollMs = getSimulateWorkerTurnPollMs();

  let blockers = await getEarlierPendingSimulationCount(input);
  /** Si hubo cola de verdad. Ver el gap, abajo. */
  let hubo = blockers > 0;

  while (blockers > 0) {
    const elapsed = Date.now() - startedAt;
    if (maxWaitMs <= 0 || elapsed >= maxWaitMs) {
      return { waitedMs: elapsed, timedOut: true, blockers };
    }

    await sleep(Math.min(Math.max(pollMs, 1), maxWaitMs - elapsed));
    blockers = await getEarlierPendingSimulationCount(input);
    hubo = true;
  }

  /*
   * El mismo respiro condicional que el del correo, por el mismo motivo.
   *
   * Acá corría SIEMPRE: un segundo y medio de sueño por cada caso simulado,
   * incluso con la cola vacía y el bucle sin dar una vuelta. Y no es un caso
   * raro: `batch-simulate` procesa los casos EN SERIE y ya los espacia con su
   * propio `delay_ms`, así que el primero de cada tanda —y todos, si van lo
   * bastante separados— encontraban cero bloqueadores y dormían igual. Con los
   * 108 escenarios eran ~162 s de sueño sobre una ruta que dura 60.
   *
   * Está para no pegarle a Gemini dos veces seguidas cuando venimos de una
   * cola, no para espaciar contra el vacío. El ritmo global contra el proveedor
   * ya lo cuida `GEMINI_MIN_REQUEST_INTERVAL_MS`, en el extractor, que sí corre
   * siempre.
   */
  const minGapMs = getSimulateWorkerMinGapMs();
  if (hubo && minGapMs > 0) await sleep(minGapMs);

  return {
    waitedMs: Date.now() - startedAt,
    timedOut: false,
    blockers: 0,
  };
}
