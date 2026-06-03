/**
 * Unit tests for src/server/email/gmail/poll-state.ts
 *
 * Tests all three DB helper functions using vi.fn() mocks for the Supabase
 * service-role client. No real DB calls are made.
 *
 * AC7:  getOrCreatePollState → creates/returns row; advancePollState → updates
 *       history_id + timestamps + clears last_error.
 * AC8:  recordPollError → updates last_error only; does NOT change history_id.
 * AC13: advancePollState is only called after a successful batch; recordPollError
 *       is called for non-fatal per-message errors (tested indirectly here via
 *       contract assertions on the update payload).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// poll-state.ts imports "server-only" — the vitest alias in vitest.config.ts
// rewrites "server-only" to tests/mocks/server-only.ts (empty module), so no
// explicit vi.mock("server-only") is needed here.

import {
  getOrCreatePollState,
  advancePollState,
  recordPollError,
} from "@/server/email/gmail/poll-state";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a Supabase mock for getOrCreatePollState.
 *
 * @param insertErrorCode  If set, the insert call resolves with this error code.
 * @param selectData       Row data returned by the follow-up SELECT.
 * @param selectErrorCode  If set, the SELECT call resolves with this error code.
 */
function makeGetOrCreateMock(opts: {
  insertErrorCode?: string;
  selectData?: { id: string; history_id: string } | null;
  selectErrorCode?: string;
}) {
  const { insertErrorCode, selectData, selectErrorCode } = opts;

  // insert chain: supabase.from(...).insert(...).select()
  const insertSelect = vi.fn().mockResolvedValue({
    data: null,
    error: insertErrorCode
      ? { code: insertErrorCode, message: "conflict" }
      : null,
  });
  const insert = vi.fn().mockReturnValue({ select: insertSelect });

  // select chain: supabase.from(...).select(...).eq(...).single()
  const single = vi.fn().mockResolvedValue({
    data: selectData ?? null,
    error: selectErrorCode
      ? { code: selectErrorCode, message: "db error" }
      : null,
  });
  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });

  // from() returns different shapes depending on what was called
  const from = vi.fn().mockImplementation(() => ({
    insert,
    select,
  }));

  return { from } as unknown as InstanceType<
    typeof import("@supabase/supabase-js").SupabaseClient
  >;
}

/**
 * Build a minimal Supabase mock for update-based operations (advancePollState,
 * recordPollError).
 *
 * Returns the full mock object (with `.from` method) plus refs to `update` and
 * `eq` for assertion. Pass the `supabase` property to the function under test.
 *
 * @param updateError  If set, the update call resolves with this error.
 */
function makeUpdateMock(opts: { updateError?: { code: string } | null } = {}) {
  const eq = vi.fn().mockResolvedValue({
    data: null,
    error: opts.updateError ?? null,
  });
  const update = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ update });
  const supabase = { from } as unknown as InstanceType<
    typeof import("@supabase/supabase-js").SupabaseClient
  >;

  return { supabase, from, update, eq };
}

// ── getOrCreatePollState ──────────────────────────────────────────────────────

describe("getOrCreatePollState", () => {
  it("creates a new row with history_id='1' when DB is empty", async () => {
    const supabase = makeGetOrCreateMock({
      insertErrorCode: undefined, // no conflict → insert succeeds
      selectData: { id: "uuid-001", history_id: "1" },
    });

    const result = await getOrCreatePollState(
      supabase as any,
      "test@gmail.com"
    );

    expect(result).toEqual({ id: "uuid-001", historyId: "1" });
  });

  it("returns the existing row without overwriting history_id on conflict", async () => {
    const supabase = makeGetOrCreateMock({
      insertErrorCode: "23505", // unique-constraint violation
      selectData: { id: "uuid-002", history_id: "99999" },
    });

    const result = await getOrCreatePollState(
      supabase as any,
      "test@gmail.com"
    );

    expect(result).toEqual({ id: "uuid-002", historyId: "99999" });
  });

  it("propagates non-conflict insert errors as thrown exceptions", async () => {
    const supabase = makeGetOrCreateMock({
      insertErrorCode: "PGRST301", // some other DB error
      selectData: null,
    });

    await expect(
      getOrCreatePollState(supabase as any, "test@gmail.com")
    ).rejects.toThrow("[poll-state] Failed to initialise gmail_poll_state row");
  });

  it("throws when the follow-up SELECT returns an error", async () => {
    const supabase = makeGetOrCreateMock({
      insertErrorCode: undefined,
      selectData: null,
      selectErrorCode: "PGRST116",
    });

    await expect(
      getOrCreatePollState(supabase as any, "test@gmail.com")
    ).rejects.toThrow("[poll-state] Failed to read gmail_poll_state row");
  });

  it("throws when the follow-up SELECT returns no data (null)", async () => {
    const supabase = makeGetOrCreateMock({
      insertErrorCode: undefined,
      selectData: null,
      selectErrorCode: undefined,
    });

    await expect(
      getOrCreatePollState(supabase as any, "test@gmail.com")
    ).rejects.toThrow("[poll-state] Failed to read gmail_poll_state row");
  });
});

// ── advancePollState ──────────────────────────────────────────────────────────

describe("advancePollState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T10:00:00.000Z"));
  });

  it("updates history_id, timestamps, and clears last_error on success", async () => {
    const { supabase, from, update, eq } = makeUpdateMock();

    await advancePollState(supabase as any, "row-uuid-abc", "12399");

    expect(from).toHaveBeenCalledWith("gmail_poll_state");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        history_id: "12399",
        last_polled_at: "2024-01-15T10:00:00.000Z",
        updated_at: "2024-01-15T10:00:00.000Z",
        last_error: null,
      })
    );
    expect(eq).toHaveBeenCalledWith("id", "row-uuid-abc");
  });

  it("throws when Supabase update returns an error", async () => {
    const { supabase } = makeUpdateMock({ updateError: { code: "PGRST301" } });

    await expect(
      advancePollState(supabase as any, "row-uuid-abc", "12399")
    ).rejects.toThrow("[poll-state] Failed to advance watermark");
  });

  it("does NOT change history_id when called with the same value (idempotent update)", async () => {
    const { supabase, update } = makeUpdateMock();

    await advancePollState(supabase as any, "row-uuid-abc", "12345");

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ history_id: "12345" })
    );
  });
});

// ── recordPollError ────────────────────────────────────────────────────────────

describe("recordPollError", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T10:00:00.000Z"));
  });

  it("updates last_error and updated_at without changing history_id", async () => {
    const { supabase, from, update, eq } = makeUpdateMock();

    await recordPollError(supabase as any, "row-uuid-abc", "historyNotFound: 404");

    expect(from).toHaveBeenCalledWith("gmail_poll_state");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        last_error: "historyNotFound: 404",
        updated_at: "2024-01-15T10:00:00.000Z",
      })
    );
    // history_id must NOT appear in the update payload
    const updateArg = (update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateArg).not.toHaveProperty("history_id");
    expect(eq).toHaveBeenCalledWith("id", "row-uuid-abc");
  });

  it("truncates error strings longer than 500 chars before storing", async () => {
    const { supabase, update } = makeUpdateMock();
    const longError = "x".repeat(600);

    await recordPollError(supabase as any, "row-uuid-abc", longError);

    const updateArg = (update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateArg.last_error).toHaveLength(500);
    expect(updateArg.last_error).toBe("x".repeat(500));
  });

  it("does not throw when Supabase update fails (non-fatal)", async () => {
    const { supabase } = makeUpdateMock({ updateError: { code: "PGRST301" } });

    // recordPollError should swallow DB errors and log them instead of throwing.
    await expect(
      recordPollError(supabase as any, "row-uuid-abc", "some error")
    ).resolves.toBeUndefined();
  });

  it("does not include history_id in update payload", async () => {
    const { supabase, update } = makeUpdateMock();

    await recordPollError(supabase as any, "row-uuid-abc", "transient error");

    const updateArg = (update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(Object.keys(updateArg)).not.toContain("history_id");
  });
});
