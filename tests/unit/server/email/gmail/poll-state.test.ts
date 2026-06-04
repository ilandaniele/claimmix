/**
 * Unit tests for getWatchExpiration() and setWatchState() in poll-state.ts.
 *
 * AC2: getWatchExpiration returns null when no row exists.
 * AC2: getWatchExpiration returns null when row exists but watch_expiration is null.
 * AC3: getWatchExpiration returns the ISO timestamp string when watch_expiration is set.
 *
 * setWatchState: upsert is called with correct fields (gmail_account_email,
 * watch_expiration, watch_history_id, updated_at), using onConflict strategy.
 *
 * Strategy: mock the Supabase client at the call-chain level so no real DB is
 * required.  All functions accept an injected SupabaseClient (no module singleton).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock 'server-only' before importing the module under test
vi.mock("server-only", () => ({}));

import {
  getWatchExpiration,
  setWatchState,
} from "@/server/email/gmail/poll-state";

// ── Helpers ───────────────────────────────────────────────────────────────────

const GMAIL_EMAIL = "claims@claimmix.com";
const EXPIRATION_ISO = "2026-06-11T18:00:00.000Z";
const HISTORY_ID = "99999";

/**
 * Build a minimal Supabase mock whose .from().select().eq().maybeSingle()
 * chain resolves to the provided result.
 */
function makeSelectMock(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { from, select, eq, maybeSingle };
}

/**
 * Build a minimal Supabase mock whose .from().upsert() chain resolves
 * to the provided result.
 */
function makeUpsertMock(result: { error: unknown }) {
  const upsert = vi.fn().mockResolvedValue(result);
  const from = vi.fn().mockReturnValue({ upsert });
  return { from, upsert };
}

// ── getWatchExpiration ────────────────────────────────────────────────────────

describe("getWatchExpiration", () => {
  describe("AC2 — returns null when no row exists", () => {
    it("returns null when maybeSingle returns data: null (no row)", async () => {
      const mock = makeSelectMock({ data: null, error: null });

      const result = await getWatchExpiration(mock as any, GMAIL_EMAIL);

      expect(result).toBeNull();
    });
  });

  describe("AC2 — returns null when row exists but watch_expiration is null", () => {
    it("returns null when row has watch_expiration: null", async () => {
      const mock = makeSelectMock({
        data: { watch_expiration: null },
        error: null,
      });

      const result = await getWatchExpiration(mock as any, GMAIL_EMAIL);

      expect(result).toBeNull();
    });

    it("returns null when row has watch_expiration: undefined (defensive)", async () => {
      const mock = makeSelectMock({
        data: { watch_expiration: undefined },
        error: null,
      });

      const result = await getWatchExpiration(mock as any, GMAIL_EMAIL);

      expect(result).toBeNull();
    });
  });

  describe("AC3 — returns ISO timestamp when watch_expiration is set", () => {
    it("returns the ISO string stored in watch_expiration", async () => {
      const mock = makeSelectMock({
        data: { watch_expiration: EXPIRATION_ISO },
        error: null,
      });

      const result = await getWatchExpiration(mock as any, GMAIL_EMAIL);

      expect(result).toBe(EXPIRATION_ISO);
    });
  });

  describe("error handling", () => {
    it("throws with error code when Supabase returns an error", async () => {
      const mock = makeSelectMock({
        data: null,
        error: { code: "PGRST301", message: "some db error" },
      });

      await expect(
        getWatchExpiration(mock as any, GMAIL_EMAIL)
      ).rejects.toThrow("[poll-state] Failed to read watch_expiration: PGRST301");
    });

    it("queries gmail_poll_state table with the correct email filter", async () => {
      const mock = makeSelectMock({ data: null, error: null });

      await getWatchExpiration(mock as any, GMAIL_EMAIL);

      expect(mock.from).toHaveBeenCalledWith("gmail_poll_state");
      expect(mock.select).toHaveBeenCalledWith("watch_expiration");
      expect(mock.eq).toHaveBeenCalledWith("gmail_account_email", GMAIL_EMAIL);
      expect(mock.maybeSingle).toHaveBeenCalledOnce();
    });
  });
});

// ── setWatchState ─────────────────────────────────────────────────────────────

describe("setWatchState", () => {
  describe("upsert fields", () => {
    it("calls upsert on gmail_poll_state with gmail_account_email, watch_expiration, watch_history_id", async () => {
      const mock = makeUpsertMock({ error: null });

      await setWatchState(mock as any, GMAIL_EMAIL, EXPIRATION_ISO, HISTORY_ID);

      expect(mock.from).toHaveBeenCalledWith("gmail_poll_state");
      expect(mock.upsert).toHaveBeenCalledOnce();

      const [payload, options] = mock.upsert.mock.calls[0] as [
        Record<string, unknown>,
        { onConflict: string },
      ];

      expect(payload.gmail_account_email).toBe(GMAIL_EMAIL);
      expect(payload.watch_expiration).toBe(EXPIRATION_ISO);
      expect(payload.watch_history_id).toBe(HISTORY_ID);
      expect(typeof payload.updated_at).toBe("string");
      expect(options.onConflict).toBe("gmail_account_email");
    });

    it("passes the exact watchExpiration and watchHistoryId provided by caller", async () => {
      const mock = makeUpsertMock({ error: null });
      const expiration = "2026-07-01T00:00:00.000Z";
      const historyId = "12345678";

      await setWatchState(mock as any, GMAIL_EMAIL, expiration, historyId);

      const [payload] = mock.upsert.mock.calls[0] as [Record<string, unknown>];
      expect(payload.watch_expiration).toBe(expiration);
      expect(payload.watch_history_id).toBe(historyId);
    });
  });

  describe("error handling", () => {
    it("throws with error code when Supabase upsert returns an error", async () => {
      const mock = makeUpsertMock({
        error: { code: "23514", message: "constraint violation" },
      });

      await expect(
        setWatchState(mock as any, GMAIL_EMAIL, EXPIRATION_ISO, HISTORY_ID)
      ).rejects.toThrow("[poll-state] Failed to set watch state: 23514");
    });

    it("resolves without throwing when upsert succeeds", async () => {
      const mock = makeUpsertMock({ error: null });

      await expect(
        setWatchState(mock as any, GMAIL_EMAIL, EXPIRATION_ISO, HISTORY_ID)
      ).resolves.toBeUndefined();
    });
  });
});
