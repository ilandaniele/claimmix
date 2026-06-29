/**
 * Unit tests for the stuck-case reaper.
 *
 * Verifies it finds cases stuck in `procesando` past the threshold, transitions
 * them to `escalado` (guarded on still being procesando), writes an audit entry
 * per case, and degrades safely.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSelect, mockUpdate, mockWriteAuditLog, state } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockUpdate: vi.fn(),
  mockWriteAuditLog: vi.fn(),
  state: {
    stuckRows: [] as Array<{ id: string; tenant_id: string }>,
    updatedRows: [] as Array<{ id: string; tenant_id: string }>,
  },
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(state.stuckRows),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(state.updatedRows),
        }),
      }),
    }),
  },
  tables: {},
}));

vi.mock("@/lib/db/schema", () => ({
  cases: { id: "id", tenant_id: "tenant_id", status: "status", created_at: "created_at", updated_at: "updated_at" },
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockWriteAuditLog,
  AuditEvent: { CASE_STATUS_CHANGED: "case.status_changed" },
}));

import { reapStuckProcessingCases, getStuckReapAfterMs } from "@/server/intake/reap-stuck";

describe("reapStuckProcessingCases", () => {
  beforeEach(() => {
    state.stuckRows = [];
    state.updatedRows = [];
    mockWriteAuditLog.mockReset();
    mockWriteAuditLog.mockResolvedValue(undefined);
    delete process.env.SIMULATE_STUCK_REAP_AFTER_MS;
  });

  it("returns 0 with no audit writes when nothing is stuck", async () => {
    const res = await reapStuckProcessingCases();
    expect(res).toEqual({ reaped: 0, caseIds: [] });
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("escalates stuck cases and writes one audit entry each", async () => {
    state.stuckRows = [
      { id: "c1", tenant_id: "t1" },
      { id: "c2", tenant_id: "t1" },
    ];
    state.updatedRows = [
      { id: "c1", tenant_id: "t1" },
      { id: "c2", tenant_id: "t1" },
    ];

    const res = await reapStuckProcessingCases({ tenantId: "t1" });
    expect(res.reaped).toBe(2);
    expect(res.caseIds).toEqual(["c1", "c2"]);

    expect(mockWriteAuditLog).toHaveBeenCalledTimes(2);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "case.status_changed",
        target_id: "c1",
        payload: expect.objectContaining({ new_status: "escalado", reason: "processing_timeout" }),
      })
    );
  });

  it("reports only the rows the guarded UPDATE actually changed", async () => {
    // SELECT saw 2 stuck, but one finished before the UPDATE (guard on status).
    state.stuckRows = [
      { id: "c1", tenant_id: "t1" },
      { id: "c2", tenant_id: "t1" },
    ];
    state.updatedRows = [{ id: "c1", tenant_id: "t1" }];

    const res = await reapStuckProcessingCases();
    expect(res.reaped).toBe(1);
    expect(res.caseIds).toEqual(["c1"]);
    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
  });

  it("honors SIMULATE_STUCK_REAP_AFTER_MS within bounds", () => {
    process.env.SIMULATE_STUCK_REAP_AFTER_MS = "60000";
    expect(getStuckReapAfterMs()).toBe(60000);
    process.env.SIMULATE_STUCK_REAP_AFTER_MS = "0";
    expect(getStuckReapAfterMs()).toBe(20 * 60_000); // invalid → default
    process.env.SIMULATE_STUCK_REAP_AFTER_MS = "999999999";
    expect(getStuckReapAfterMs()).toBe(2 * 60 * 60_000); // clamped to max
  });
});
