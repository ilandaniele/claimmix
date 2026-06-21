import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDbSelect } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
  },
}));

const originalEnv = {
  SIMULATE_WORKER_DELAY_MS: process.env.SIMULATE_WORKER_DELAY_MS,
  SIMULATE_WORKER_MAX_DELAY_MS: process.env.SIMULATE_WORKER_MAX_DELAY_MS,
  SIMULATE_WORKER_LOOKBACK_MS: process.env.SIMULATE_WORKER_LOOKBACK_MS,
};

describe("simulation worker throttle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SIMULATE_WORKER_DELAY_MS = "5000";
    process.env.SIMULATE_WORKER_MAX_DELAY_MS = "12000";
    process.env.SIMULATE_WORKER_LOOKBACK_MS = "900000";
  });

  afterEach(() => {
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
});
