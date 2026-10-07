/**
 * Unit tests for getWatchExpiration() and setWatchState() in poll-state.ts.
 *
 * AC2: getWatchExpiration returns null when no row exists.
 * AC2: getWatchExpiration returns null when row exists but watch_expiration is null.
 * AC3: getWatchExpiration returns the ISO timestamp string when watch_expiration is set.
 *
 * setWatchState: upsert (insert + onConflictDoUpdate) is called with correct fields
 * (gmail_account_email, watch_expiration, watch_history_id, updated_at).
 *
 * clearWatchState: UPDATE (no DELETE) que deja watch_expiration y
 * watch_history_id en null, filtrado por la casilla.
 *
 * Strategy: mock @/lib/db at the module level so no real DB is required.
 * Functions use the module-level db singleton (no injected client).
 */

// vi.mock() is hoisted before any imports by Vitest.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  tables: {},
}));

vi.mock("@/lib/db/schema", () => ({
  cases: {},
  claimMessages: {},
  claimAttachments: {},
  gmailPollState: {
    gmail_account_email: "gmail_account_email",
    watch_expiration: "watch_expiration",
    watch_history_id: "watch_history_id",
  },
}));

vi.mock("@/lib/db/helpers", () => ({
  firstRow: <T>(rows: T[]): T | null => rows[0] ?? null,
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/lib/db";

import {
  clearWatchState,
  getWatchExpiration,
  setWatchState,
} from "@/server/email/gmail/poll-state";

// ── Constants ─────────────────────────────────────────────────────────────────

const GMAIL_EMAIL = "claims@claimmix.com";
const EXPIRATION_ISO = "2026-06-11T18:00:00.000Z";
const HISTORY_ID = "99999";

// ── getWatchExpiration ────────────────────────────────────────────────────────

describe("getWatchExpiration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("AC2 — returns null when no row exists", () => {
    it("returns null when select returns empty array (no row)", async () => {
      // db.select().from().where().limit() → []
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const result = await getWatchExpiration(GMAIL_EMAIL);

      expect(result).toBeNull();
    });
  });

  describe("AC2 — returns null when row exists but watch_expiration is null", () => {
    it("returns null when row has watch_expiration: null", async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ watch_expiration: null }]),
          }),
        }),
      } as any);

      const result = await getWatchExpiration(GMAIL_EMAIL);

      expect(result).toBeNull();
    });

    it("returns null when row has watch_expiration: undefined (defensive)", async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ watch_expiration: undefined }]),
          }),
        }),
      } as any);

      const result = await getWatchExpiration(GMAIL_EMAIL);

      expect(result).toBeNull();
    });
  });

  describe("AC3 — returns ISO timestamp when watch_expiration is set", () => {
    it("returns the ISO string stored in watch_expiration", async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ watch_expiration: EXPIRATION_ISO }]),
          }),
        }),
      } as any);

      const result = await getWatchExpiration(GMAIL_EMAIL);

      expect(result).toBe(EXPIRATION_ISO);
    });
  });

  describe("error handling", () => {
    it("throws with error code when db.select rejects", async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockRejectedValue({ code: "PGRST301", message: "some db error" }),
          }),
        }),
      } as any);

      await expect(
        getWatchExpiration(GMAIL_EMAIL)
      ).rejects.toThrow("[poll-state] Failed to read watch_expiration: PGRST301");
    });

    it("queries gmailPollState table with the correct email filter", async () => {
      const limitMock = vi.fn().mockResolvedValue([]);
      const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
      const fromMock = vi.fn().mockReturnValue({ where: whereMock });
      vi.mocked(db.select).mockReturnValue({ from: fromMock } as any);

      await getWatchExpiration(GMAIL_EMAIL);

      // db.select() should be called (selecting watch_expiration column)
      expect(db.select).toHaveBeenCalledOnce();
      // from() should be called with the gmailPollState table
      expect(fromMock).toHaveBeenCalledOnce();
      // where() should be called once (email filter)
      expect(whereMock).toHaveBeenCalledOnce();
      // limit(1) should be called
      expect(limitMock).toHaveBeenCalledWith(1);
    });
  });
});

// ── setWatchState ─────────────────────────────────────────────────────────────

describe("setWatchState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("upsert fields", () => {
    it("calls insert + onConflictDoUpdate on gmailPollState with correct fields", async () => {
      // setWatchState uses:
      //   db.insert(gmailPollState)
      //     .values({ gmail_account_email, watch_expiration, watch_history_id, updated_at })
      //     .onConflictDoUpdate({ target: [...], set: { ... } })
      let capturedValues: Record<string, unknown> = {};
      let capturedConflictSet: Record<string, unknown> = {};

      const onConflictDoUpdate = vi.fn().mockImplementation((opts: { set: Record<string, unknown> }) => {
        capturedConflictSet = opts.set;
        return Promise.resolve(undefined);
      });

      const valuesMock = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
        capturedValues = payload;
        return { onConflictDoUpdate };
      });

      vi.mocked(db.insert).mockReturnValue({
        values: valuesMock,
      } as any);

      await setWatchState(GMAIL_EMAIL, EXPIRATION_ISO, HISTORY_ID);

      expect(db.insert).toHaveBeenCalledOnce();
      expect(valuesMock).toHaveBeenCalledOnce();
      expect(onConflictDoUpdate).toHaveBeenCalledOnce();

      // values() payload
      expect(capturedValues.gmail_account_email).toBe(GMAIL_EMAIL);
      expect(capturedValues.watch_expiration).toBe(EXPIRATION_ISO);
      expect(capturedValues.watch_history_id).toBe(HISTORY_ID);
      expect(typeof capturedValues.updated_at).toBe("string");

      // onConflictDoUpdate set payload
      expect(capturedConflictSet.watch_expiration).toBe(EXPIRATION_ISO);
      expect(capturedConflictSet.watch_history_id).toBe(HISTORY_ID);
      expect(typeof capturedConflictSet.updated_at).toBe("string");
    });

    it("passes the exact watchExpiration and watchHistoryId provided by caller", async () => {
      const expiration = "2026-07-01T00:00:00.000Z";
      const historyId = "12345678";

      let capturedValues: Record<string, unknown> = {};

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          capturedValues = payload;
          return {
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          };
        }),
      } as any);

      await setWatchState(GMAIL_EMAIL, expiration, historyId);

      expect(capturedValues.watch_expiration).toBe(expiration);
      expect(capturedValues.watch_history_id).toBe(historyId);
    });
  });

  describe("error handling", () => {
    it("throws with error code when db.insert chain rejects", async () => {
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockRejectedValue({ code: "23514", message: "constraint violation" }),
        }),
      } as any);

      await expect(
        setWatchState(GMAIL_EMAIL, EXPIRATION_ISO, HISTORY_ID)
      ).rejects.toThrow("[poll-state] Failed to set watch state: 23514");
    });

    it("resolves without throwing when insert succeeds", async () => {
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      await expect(
        setWatchState(GMAIL_EMAIL, EXPIRATION_ISO, HISTORY_ID)
      ).resolves.toBeUndefined();
    });
  });
});

// ── clearWatchState ───────────────────────────────────────────────────────────

describe("clearWatchState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hace un UPDATE que pone la marca del watch en null, filtrado por casilla", async () => {
    let capturedSet: Record<string, unknown> = {};
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
      capturedSet = payload;
      return { where: whereMock };
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    await clearWatchState(GMAIL_EMAIL);

    expect(db.update).toHaveBeenCalledOnce();
    expect(whereMock).toHaveBeenCalledOnce();
    expect(capturedSet.watch_expiration).toBeNull();
    expect(capturedSet.watch_history_id).toBeNull();
    expect(typeof capturedSet.updated_at).toBe("string");
    // history_id y los pendientes son del poller: no se tocan.
    expect(Object.keys(capturedSet).sort()).toEqual(["updated_at", "watch_expiration", "watch_history_id"]);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("tira con el código de Postgres y sin la dirección cuando el UPDATE falla", async () => {
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue({ code: "57P01", message: GMAIL_EMAIL }),
      }),
    } as any);

    const error = await clearWatchState(GMAIL_EMAIL).catch((e: Error) => e);

    expect((error as Error).message).toBe("[poll-state] Failed to clear watch state: 57P01");
    expect((error as Error).message).not.toContain(GMAIL_EMAIL);
  });
});
