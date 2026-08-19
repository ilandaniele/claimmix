/**
 * Giving up on a conversation, without giving up on a claim.
 *
 * The distinction is the whole point. A case where we asked for a policy
 * number and nobody ever answered is an abandoned conversation and belongs
 * closed — nineteen of them piled up in one day of testing. A case in
 * `listo_para_core` is a finished conversation and an unfinished claim: it is
 * waiting on the insurer, and closing it would hide real work behind a tidy
 * board.
 */

vi.mock("@/lib/db", () => ({
  db: { update: vi.fn() },
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: { CASE_CLOSED_ABANDONED: "claim.closed_abandoned" },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  closeAbandonedConversations,
  getAbandonAfterDays,
  ABANDONABLE_STATUSES,
} from "@/server/intake/close-abandoned";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit/log";

let updatedWith: Record<string, unknown> | null;

function updateReturns(rows: Array<{ id: string; tenant_id: string }>) {
  (db.update as ReturnType<typeof vi.fn>).mockReturnValue({
    set: (data: Record<string, unknown>) => {
      updatedWith = data;
      return { where: () => ({ returning: () => Promise.resolve(rows) }) };
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  updatedWith = null;
  delete process.env.CONVERSATION_ABANDON_AFTER_DAYS;
});

afterEach(() => {
  delete process.env.CONVERSATION_ABANDON_AFTER_DAYS;
});

describe("closeAbandonedConversations — what it will and will not touch", () => {
  it("only sweeps the two states that mean we are the ones waiting", () => {
    // Both are set by the agent right after it writes to the claimant, so
    // silence in them is genuinely the claimant's silence.
    expect([...ABANDONABLE_STATUSES]).toEqual(["info_faltante", "confirmacion_pendiente"]);
  });

  it("leaves a finished claim alone", () => {
    // listo_para_core is a completed conversation and an open claim. Closing
    // it would report work as done that nobody has done.
    expect([...ABANDONABLE_STATUSES]).not.toContain("listo_para_core");
    expect([...ABANDONABLE_STATUSES]).not.toContain("requiere_especialista");
  });

  it("closes with a timestamp, not just a status", async () => {
    updateReturns([{ id: "case-1", tenant_id: "t1" }]);

    const result = await closeAbandonedConversations();

    expect(result.closed).toBe(1);
    expect(updatedWith).toMatchObject({ status: "cerrado" });
    expect(updatedWith?.closed_at).toBeTruthy();
  });

  it("records why each one was closed", async () => {
    // "Closed" with no reason is indistinguishable from a human deciding it.
    updateReturns([
      { id: "case-1", tenant_id: "t1" },
      { id: "case-2", tenant_id: "t2" },
    ]);

    await closeAbandonedConversations();

    expect(writeAuditLog).toHaveBeenCalledTimes(2);
    expect(vi.mocked(writeAuditLog).mock.calls[0][0]).toMatchObject({
      event_type: "claim.closed_abandoned",
      target_id: "case-1",
      tenant_id: "t1",
      payload: { after_days: 14, reason: "sin respuesta del denunciante" },
    });
  });

  it("does nothing loudly when there is nothing to close", async () => {
    updateReturns([]);

    const result = await closeAbandonedConversations();

    expect(result).toEqual({ closed: 0, caseIds: [] });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("survives a database failure — the nightly run has other work", async () => {
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("connection lost");
    });

    await expect(closeAbandonedConversations()).resolves.toEqual({
      closed: 0,
      caseIds: [],
    });
  });
});

describe("getAbandonAfterDays", () => {
  it("waits two weeks by default", () => {
    expect(getAbandonAfterDays()).toBe(14);
  });

  it("takes the operator's number over ours", () => {
    process.env.CONVERSATION_ABANDON_AFTER_DAYS = "30";
    expect(getAbandonAfterDays()).toBe(30);
  });

  it("ignores nonsense rather than closing everything at once", () => {
    for (const bad of ["0", "-5", "abc", ""]) {
      process.env.CONVERSATION_ABANDON_AFTER_DAYS = bad;
      expect(getAbandonAfterDays(), bad).toBe(14);
    }
  });

  it("caps the wait so a typo cannot disable the sweep for a decade", () => {
    process.env.CONVERSATION_ABANDON_AFTER_DAYS = "99999";
    expect(getAbandonAfterDays()).toBe(90);
  });
});
