import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDbSelect } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
}));

// La capa de datos, corriendo contra el db que este test ya simula.
//
// Se lee `mod.db` en CADA llamada y no se desestructura: hay tests que
// intercambian la base simulada entre casos, y un `const { db } = ...`
// congelaría el valor de la primera.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
  },
}));

const originalEnv = {
  SIMULATE_WORKER_DELAY_MS: process.env.SIMULATE_WORKER_DELAY_MS,
  SIMULATE_WORKER_MAX_DELAY_MS: process.env.SIMULATE_WORKER_MAX_DELAY_MS,
  SIMULATE_WORKER_LOOKBACK_MS: process.env.SIMULATE_WORKER_LOOKBACK_MS,
  SIMULATE_WORKER_TURN_POLL_MS: process.env.SIMULATE_WORKER_TURN_POLL_MS,
  SIMULATE_WORKER_TURN_MAX_WAIT_MS:
    process.env.SIMULATE_WORKER_TURN_MAX_WAIT_MS,
  SIMULATE_WORKER_MIN_GAP_MS: process.env.SIMULATE_WORKER_MIN_GAP_MS,
  SIMULATE_WORKER_STALE_AFTER_MS: process.env.SIMULATE_WORKER_STALE_AFTER_MS,
};

describe("simulation worker throttle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SIMULATE_WORKER_DELAY_MS = "5000";
    process.env.SIMULATE_WORKER_MAX_DELAY_MS = "12000";
    process.env.SIMULATE_WORKER_LOOKBACK_MS = "900000";
    process.env.SIMULATE_WORKER_TURN_POLL_MS = "1000";
    process.env.SIMULATE_WORKER_TURN_MAX_WAIT_MS = "5000";
    process.env.SIMULATE_WORKER_MIN_GAP_MS = "0";
    process.env.SIMULATE_WORKER_STALE_AFTER_MS = "600000";
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("spaces workers by their recent simulated-case position", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ queued_count: 3 }]),
      }),
    });

    const { getSimulationWorkerDelayMs } = await import(
      "@/server/intake/simulation-throttle"
    );

    const delayMs = await getSimulationWorkerDelayMs({
      tenantId: "tenant-001",
      caseId: "22222222-2222-4222-8222-222222222222",
      caseCreatedAt: "2026-06-21T21:53:00.000Z",
    });

    expect(delayMs).toBe(10000);
  });

  it("caps long batches to the configured max delay", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ queued_count: 20 }]),
      }),
    });

    const { getSimulationWorkerDelayMs } = await import(
      "@/server/intake/simulation-throttle"
    );

    const delayMs = await getSimulationWorkerDelayMs({
      tenantId: "tenant-001",
      caseId: "22222222-2222-4222-8222-222222222222",
      caseCreatedAt: "2026-06-21T21:53:00.000Z",
    });

    expect(delayMs).toBe(12000);
  });

  it("does not touch the database when no created_at is available", async () => {
    const { getSimulationWorkerDelayMs } = await import(
      "@/server/intake/simulation-throttle"
    );

    const delayMs = await getSimulationWorkerDelayMs({
      tenantId: "tenant-001",
      caseId: "22222222-2222-4222-8222-222222222222",
      caseCreatedAt: null,
    });

    expect(delayMs).toBe(0);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("counts earlier pending simulated workers", async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ queued_count: 2 }]),
      }),
    });

    const { getEarlierPendingSimulationCount } = await import(
      "@/server/intake/simulation-throttle"
    );

    const blockers = await getEarlierPendingSimulationCount({
      tenantId: "tenant-001",
      caseId: "22222222-2222-4222-8222-222222222222",
      caseCreatedAt: "2026-06-21T21:53:00.000Z",
    });

    expect(blockers).toBe(2);
  });

  it("waits until earlier pending simulated workers clear", async () => {
    vi.useFakeTimers();
    const counts = [2, 0];
    mockDbSelect.mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ queued_count: counts.shift() ?? 0 }]),
      }),
    }));

    const { waitForSimulationTurn } = await import(
      "@/server/intake/simulation-throttle"
    );

    const promise = waitForSimulationTurn({
      tenantId: "tenant-001",
      caseId: "22222222-2222-4222-8222-222222222222",
      caseCreatedAt: "2026-06-21T21:53:00.000Z",
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toMatchObject({
      timedOut: false,
      blockers: 0,
    });
    expect(mockDbSelect).toHaveBeenCalledTimes(2);
  });
});
