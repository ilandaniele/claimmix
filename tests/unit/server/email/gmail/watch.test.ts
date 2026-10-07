/**
 * Unit tests for setupGmailWatch() in watch.ts.
 *
 * AC1: setupGmailWatch calls gmail.users.watch, returns {historyId, expiration},
 *      and calls setWatchState() with the converted ISO expiration timestamp.
 *
 * Additional cases:
 * - Missing historyId in API response → throws.
 * - Missing expiration in API response → throws.
 * - Expiration ms-epoch string is correctly converted to ISO-8601.
 *
 * stopGmailWatch: llama users.stop y limpia la marca; un 404/400 de Google (no
 * había watch) no tira; cualquier otro error sí y no limpia nada.
 *
 * Strategy:
 * - Mock getGmailClient() to return a controlled gmail object.
 * - Mock setWatchState() to verify call arguments without hitting Neon.
 * - No real database client is constructed.
 * - All mocks are reset between tests via beforeEach.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock 'server-only' before any module-under-test is imported.
vi.mock("server-only", () => ({}));

// Mock the gmail-client module — getGmailClient() returns our controlled fake.
vi.mock("@/server/email/gmail/gmail-client", () => ({
  getGmailClient: vi.fn(),
}));

// Mock setWatchState — we verify arguments; no real DB needed.
vi.mock("@/server/email/gmail/poll-state", () => ({
  setWatchState: vi.fn(),
  clearWatchState: vi.fn(),
}));

// Mock @/lib/db to prevent DATABASE_URL errors on any transitive imports.
vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  tables: {},
}));

import { setupGmailWatch, stopGmailWatch } from "@/server/email/gmail/watch";
import { getGmailClient } from "@/server/email/gmail/gmail-client";
import { clearWatchState, setWatchState } from "@/server/email/gmail/poll-state";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TOPIC_NAME = "projects/claimmix/topics/gmail-push";
const GMAIL_EMAIL = "claims@claimmix.com";

/** The raw ms-epoch expiration string returned by the Gmail API. */
const EXPIRATION_MS = "1750000000000";

/** The expected ISO conversion of EXPIRATION_MS. */
const EXPIRATION_ISO = new Date(Number(EXPIRATION_MS)).toISOString();

const HISTORY_ID = "123";

/**
 * Build a minimal mock gmail client whose users.watch() resolves to the
 * provided data payload.
 */
function makeGmailMock(data: Record<string, unknown>) {
  const watchFn = vi.fn().mockResolvedValue({ data });
  return {
    users: { watch: watchFn },
    _watchFn: watchFn,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("setupGmailWatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Provide a default GMAIL_USER_EMAIL so individual tests don't need to set it.
    process.env.GMAIL_USER_EMAIL = GMAIL_EMAIL;
  });

  describe("AC1 — happy path: watch registered and state persisted", () => {
    it("returns { historyId, expiration } and calls setWatchState with correct args", async () => {
      const mock = makeGmailMock({ historyId: HISTORY_ID, expiration: EXPIRATION_MS });
      vi.mocked(getGmailClient).mockReturnValue(mock as any);

      const result = await setupGmailWatch(TOPIC_NAME);

      // Return value
      expect(result).toEqual({
        historyId: HISTORY_ID,
        expiration: EXPIRATION_ISO,
      });

      // gmail.users.watch called with correct userId and requestBody
      expect(mock._watchFn).toHaveBeenCalledOnce();
      expect(mock._watchFn).toHaveBeenCalledWith({
        userId: "me",
        requestBody: {
          topicName: TOPIC_NAME,
          labelIds: ["INBOX"],
        },
      });

      // setWatchState persists the ISO expiration, not the raw ms string
      expect(setWatchState).toHaveBeenCalledOnce();
      const [email, expIso, hId] = vi.mocked(setWatchState).mock
        .calls[0] as [string, string, string];
      expect(email).toBe(GMAIL_EMAIL);
      expect(expIso).toBe(EXPIRATION_ISO);
      expect(hId).toBe(HISTORY_ID);
    });
  });

  describe("expiration conversion", () => {
    it("converts ms-epoch string '1750000000000' to the correct ISO timestamp", async () => {
      const ms = "1750000000000";
      const expected = new Date(Number(ms)).toISOString();
      const mock = makeGmailMock({ historyId: HISTORY_ID, expiration: ms });
      vi.mocked(getGmailClient).mockReturnValue(mock as any);

      const { expiration } = await setupGmailWatch(TOPIC_NAME);

      expect(expiration).toBe(expected);
      // Sanity check: result must be a valid UTC ISO string
      expect(new Date(expiration).getTime()).toBe(1750000000000);
    });

    it("converts a different ms-epoch string correctly", async () => {
      const ms = "1800000000000";
      const expected = new Date(1800000000000).toISOString();
      const mock = makeGmailMock({ historyId: "456", expiration: ms });
      vi.mocked(getGmailClient).mockReturnValue(mock as any);

      const { expiration } = await setupGmailWatch(TOPIC_NAME);

      expect(expiration).toBe(expected);
    });
  });

  describe("error: missing historyId in response", () => {
    it("throws when historyId is absent from the API response", async () => {
      const mock = makeGmailMock({ expiration: EXPIRATION_MS }); // no historyId
      vi.mocked(getGmailClient).mockReturnValue(mock as any);

      await expect(setupGmailWatch(TOPIC_NAME)).rejects.toThrow(
        "[watch] gmail.users.watch response missing historyId"
      );
    });

    it("throws when historyId is null", async () => {
      const mock = makeGmailMock({ historyId: null, expiration: EXPIRATION_MS });
      vi.mocked(getGmailClient).mockReturnValue(mock as any);

      await expect(setupGmailWatch(TOPIC_NAME)).rejects.toThrow(
        "[watch] gmail.users.watch response missing historyId"
      );
    });
  });

  describe("error: missing expiration in response", () => {
    it("throws when expiration is absent from the API response", async () => {
      const mock = makeGmailMock({ historyId: HISTORY_ID }); // no expiration
      vi.mocked(getGmailClient).mockReturnValue(mock as any);

      await expect(setupGmailWatch(TOPIC_NAME)).rejects.toThrow(
        "[watch] gmail.users.watch response missing expiration"
      );
    });

    it("throws when expiration is null", async () => {
      const mock = makeGmailMock({ historyId: HISTORY_ID, expiration: null });
      vi.mocked(getGmailClient).mockReturnValue(mock as any);

      await expect(setupGmailWatch(TOPIC_NAME)).rejects.toThrow(
        "[watch] gmail.users.watch response missing expiration"
      );
    });
  });

  describe("setWatchState receives the ISO-converted expiration, not the raw ms string", () => {
    it("never passes the raw ms string to setWatchState", async () => {
      const mock = makeGmailMock({ historyId: HISTORY_ID, expiration: EXPIRATION_MS });
      vi.mocked(getGmailClient).mockReturnValue(mock as any);

      await setupGmailWatch(TOPIC_NAME);

      const [, expArg] = vi.mocked(setWatchState).mock.calls[0] as [
        string,
        string,
        string,
      ];
      // Must be ISO format, not the raw numeric ms string
      expect(expArg).not.toBe(EXPIRATION_MS);
      expect(expArg).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });
});

describe("stopGmailWatch", () => {
  const CUENTA = { email: "otra@example.com", refreshToken: "fake-refresh" };

  const gmailQueFalla = (error?: unknown) => {
    const stopFn = error === undefined
      ? vi.fn().mockResolvedValue({ data: {} })
      : vi.fn().mockRejectedValue(error);
    vi.mocked(getGmailClient).mockReturnValue({ users: { stop: stopFn } } as any);
    return stopFn;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("llama users.stop con el token de la casilla y limpia la marca de esa casilla", async () => {
    const stopFn = gmailQueFalla();

    await stopGmailWatch(CUENTA);

    expect(getGmailClient).toHaveBeenCalledWith("fake-refresh");
    expect(stopFn).toHaveBeenCalledOnce();
    expect(stopFn).toHaveBeenCalledWith({ userId: "me" });
    expect(clearWatchState).toHaveBeenCalledOnce();
    expect(clearWatchState).toHaveBeenCalledWith("otra@example.com");
  });

  it.each([404, 400])("un %s de Google (no había watch) no tira y limpia la marca igual", async (status) => {
    gmailQueFalla(Object.assign(new Error("sin watch"), { status }));

    await expect(stopGmailWatch(CUENTA)).resolves.toBeUndefined();

    expect(clearWatchState).toHaveBeenCalledWith("otra@example.com");
  });

  it("el status también se lee de `code` y de `response.status`", async () => {
    gmailQueFalla(Object.assign(new Error("sin watch"), { code: 404 }));
    await expect(stopGmailWatch(CUENTA)).resolves.toBeUndefined();

    gmailQueFalla(Object.assign(new Error("sin watch"), { response: { status: 400 } }));
    await expect(stopGmailWatch(CUENTA)).resolves.toBeUndefined();

    expect(clearWatchState).toHaveBeenCalledTimes(2);
  });

  it.each([401, 500, "ECONNRESET"])("un error %s tira y no limpia la marca: el watch puede seguir vivo", async (status) => {
    const error = Object.assign(new Error("falló"), { code: status });
    gmailQueFalla(error);

    await expect(stopGmailWatch(CUENTA)).rejects.toBe(error);

    expect(clearWatchState).not.toHaveBeenCalled();
  });

  it("si limpiar la marca falla, el error llega al llamador", async () => {
    gmailQueFalla();
    vi.mocked(clearWatchState).mockRejectedValueOnce(new Error("[poll-state] Failed to clear watch state: 57P01"));

    await expect(stopGmailWatch(CUENTA)).rejects.toThrow("Failed to clear watch state: 57P01");
  });
});
