/**
 * Unit tests for src/server/email/gmail/poll-state.ts
 *
 * Tests all three DB helper functions using vi.fn() mocks for the Drizzle db.
 * No real DB calls are made.
 *
 * AC7:  getOrCreatePollState → creates/returns row; advancePollState → updates
 *       history_id + timestamps + clears last_error.
 * AC8:  recordPollError → updates last_error only; does NOT change history_id.
 * AC13: advancePollState is only called after a successful batch; recordPollError
 *       is called for non-fatal per-message errors (tested indirectly here via
 *       contract assertions on the update payload).
 */

// vi.mock() must be at module top level — Vitest hoists these calls.
vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  },
  tables: {},
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/lib/db";

import {
  getOrCreatePollState,
  advancePollState,
  recordPollError,
} from "@/server/email/gmail/poll-state";

// ── getOrCreatePollState ──────────────────────────────────────────────────────

describe("getOrCreatePollState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new row with history_id='1' when DB is empty", async () => {
    // Insert chain: db.insert(...).values(...).onConflictDoNothing(...)
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    // Select chain: db.select(...).from(...).where(...).limit(...)
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: "uuid-001", history_id: "1" }]),
        }),
      }),
    } as any);

    const result = await getOrCreatePollState("test@gmail.com");

    expect(result).toEqual({ id: "uuid-001", historyId: "1" });
  });

  it("returns the existing row without overwriting history_id on conflict", async () => {
    // Insert resolves normally (onConflictDoNothing handles conflict silently)
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: "uuid-002", history_id: "99999" }]),
        }),
      }),
    } as any);

    const result = await getOrCreatePollState("test@gmail.com");

    expect(result).toEqual({ id: "uuid-002", historyId: "99999" });
  });

  it("propagates non-conflict insert errors as thrown exceptions", async () => {
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockRejectedValue({ code: "PGRST301", message: "some DB error" }),
      }),
    } as any);

    await expect(
      getOrCreatePollState("test@gmail.com")
    ).rejects.toThrow("[poll-state] Failed to initialise gmail_poll_state row");
  });

  it("throws when the follow-up SELECT returns an error", async () => {
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockRejectedValue({ code: "PGRST116", message: "db error" }),
        }),
      }),
    } as any);

    await expect(
      getOrCreatePollState("test@gmail.com")
    ).rejects.toThrow("[poll-state] Failed to read gmail_poll_state row");
  });

  it("throws when the follow-up SELECT returns no data (null)", async () => {
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    // Empty array → firstRow returns null
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    await expect(
      getOrCreatePollState("test@gmail.com")
    ).rejects.toThrow("[poll-state] Failed to read gmail_poll_state row");
  });
});

// ── advancePollState ──────────────────────────────────────────────────────────

describe("advancePollState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T10:00:00.000Z"));
  });

  it("updates history_id, timestamps, and clears last_error on success", async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    await advancePollState("row-uuid-abc", "12399");

    expect(db.update).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        history_id: "12399",
        last_polled_at: "2024-01-15T10:00:00.000Z",
        updated_at: "2024-01-15T10:00:00.000Z",
        last_error: null,
      })
    );
    expect(whereMock).toHaveBeenCalled();
  });

  it("throws when db.update returns an error", async () => {
    const whereMock = vi.fn().mockRejectedValue({ code: "PGRST301" });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    await expect(
      advancePollState("row-uuid-abc", "12399")
    ).rejects.toThrow("[poll-state] Failed to advance watermark");
  });

  it("does NOT change history_id when called with the same value (idempotent update)", async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    await advancePollState("row-uuid-abc", "12345");

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ history_id: "12345" })
    );
  });
});

// ── recordPollError ────────────────────────────────────────────────────────────

describe("recordPollError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T10:00:00.000Z"));
  });

  it("updates last_error and updated_at without changing history_id", async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    await recordPollError("row-uuid-abc", "historyNotFound: 404");

    expect(db.update).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        last_error: "historyNotFound: 404",
        updated_at: "2024-01-15T10:00:00.000Z",
      })
    );
    // history_id must NOT appear in the update payload
    const updateArg = (setMock as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateArg).not.toHaveProperty("history_id");
    expect(whereMock).toHaveBeenCalled();
  });

  it("truncates error strings longer than 500 chars before storing", async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    const longError = "x".repeat(600);

    await recordPollError("row-uuid-abc", longError);

    const updateArg = (setMock as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateArg.last_error).toHaveLength(500);
    expect(updateArg.last_error).toBe("x".repeat(500));
  });

  it("does not throw when db.update fails (non-fatal)", async () => {
    const whereMock = vi.fn().mockRejectedValue({ code: "PGRST301" });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    // recordPollError should swallow DB errors and log them instead of throwing.
    await expect(
      recordPollError("row-uuid-abc", "some error")
    ).resolves.toBeUndefined();
  });

  it("does not include history_id in update payload", async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    await recordPollError("row-uuid-abc", "transient error");

    const updateArg = (setMock as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(Object.keys(updateArg)).not.toContain("history_id");
  });
});
