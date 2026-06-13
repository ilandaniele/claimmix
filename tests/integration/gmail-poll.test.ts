/**
 * Integration tests for src/server/email/gmail/gmail-poller.ts
 *
 * All external dependencies are mocked (googleapis, @/lib/db, audit log,
 * rehost-attachments, thread-lookup, dedupe, poll-state). No real network
 * calls or DB writes occur.
 *
 * Covered scenarios (per spec):
 *  AC1:  Happy-path ingest → claim_messages row with direction='inbound', provider='gmail'.
 *  AC2:  Already-seen messageId → skipped (no duplicate row, skipped counter increments).
 *  AC3:  In-Reply-To matching existing case → same case_id used, no new case created.
 *  AC4:  headers array (jsonb) + raw_payload (jsonb) stored; body_text/body_html decoded.
 *  AC7:  Watermark advances after successful batch.
 *  AC8:  Watermark advances even when all messages fail (prevents permanent retry loops).
 *  AC10: Error in one message → next message still processed (per-message isolation).
 *  AC13: attachment part → adaptGmailAttachments + rehostAttachments called.
 *  AC14: mark-as-read (modify) called after successful insert; failure is non-fatal.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks (must be declared before any imports that load the modules) ─────────

// Mock googleapis — gmail client factory will return our mock instance.
const {
  mockHistoryList,
  mockMessagesList,
  mockMessagesGet,
  mockMessagesModify,
  mockGetProfile,
  MockOAuth2,
  mockGmailFn,
  mockGetWatchExpiration,
  mockSetupGmailWatch,
  // DB tracking arrays - shared via closure so tests can inspect inserts/updates
  dbInserts,
  dbUpdates,
  mockDbInsert,
  mockDbSelect,
  mockDbUpdate,
} = vi.hoisted(() => {
  const mockHistoryList = vi.fn();
  const mockMessagesList = vi.fn();
  const mockMessagesGet = vi.fn();
  const mockMessagesModify = vi.fn();
  const mockGetProfile = vi.fn();
  const MockOAuth2 = vi.fn(function (this: unknown) {
    return { setCredentials: vi.fn() };
  });
  const mockGmailFn = vi.fn();
  const mockGetWatchExpiration = vi.fn();
  const mockSetupGmailWatch = vi.fn();

  // Tracked DB calls
  const dbInserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const dbUpdates: Array<{ table: string; values: Record<string, unknown> }> = [];

  // IDs that the db mock returns for inserted rows
  const CASE_UUID = "case-uuid-test-001";
  const CLAIM_MSG_UUID = "claim-msg-uuid-001";

  /**
   * Build a chainable Drizzle-style insert mock.
   * Tracks the inserted values in dbInserts and returns the configured id.
   */
  function mockDbInsert(returnId: string, tableName: string) {
    return vi.fn().mockImplementation((values: Record<string, unknown>) => {
      const rows = Array.isArray(values) ? values : [values];
      for (const row of rows) {
        dbInserts.push({ table: tableName, values: row as Record<string, unknown> });
      }
      return {
        returning: vi.fn().mockResolvedValue([{ id: returnId }]),
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
        onConflictDoUpdate: vi.fn().mockResolvedValue([]),
      };
    });
  }

  /**
   * Build a chainable Drizzle-style select mock that returns empty results.
   */
  function mockDbSelect() {
    return vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
  }

  /**
   * Build a chainable Drizzle-style update mock.
   */
  function mockDbUpdate(tableName: string) {
    return vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation((values: unknown) => {
          dbUpdates.push({ table: tableName, values: values as Record<string, unknown> });
          return Promise.resolve([]);
        }),
      }),
    });
  }

  return {
    mockHistoryList,
    mockMessagesList,
    mockMessagesGet,
    mockMessagesModify,
    mockGetProfile,
    MockOAuth2,
    mockGmailFn,
    mockGetWatchExpiration,
    mockSetupGmailWatch,
    dbInserts,
    dbUpdates,
    mockDbInsert,
    mockDbSelect,
    mockDbUpdate,
    CASE_UUID,
    CLAIM_MSG_UUID,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: MockOAuth2 },
    gmail: mockGmailFn,
  },
}));

// Mock @/lib/db so no DATABASE_URL is required and we can track calls.
// The db object needs insert/select/update methods that return chainable builders.
vi.mock("@/lib/db", () => {
  const CASE_UUID_INNER = "case-uuid-test-001";
  const CLAIM_MSG_UUID_INNER = "claim-msg-uuid-001";

  // We expose the same dbInserts/dbUpdates arrays via the hoisted closure.
  // But we need them inside this factory — use a local proxy that pushes into
  // the hoisted arrays by re-importing them at call time via the closure.
  const insertProxy = (tableName: string, returnId: string) =>
    vi.fn().mockImplementation((values: unknown) => {
      const rows = Array.isArray(values) ? values : [values];
      for (const row of rows) {
        dbInserts.push({ table: tableName, values: row as Record<string, unknown> });
      }
      return {
        returning: vi.fn().mockResolvedValue([{ id: returnId }]),
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
        onConflictDoUpdate: vi.fn().mockResolvedValue([]),
      };
    });

  const updateProxy = (tableName: string) =>
    vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          dbUpdates.push({ table: tableName, values: {} });
          return Promise.resolve([]);
        }),
      }),
    });

  const selectProxy = () =>
    vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

  const db = {
    insert: vi.fn().mockImplementation((table: { _: { name?: string }; tableName?: string }) => {
      const name = (table as unknown as { tableName?: string }).tableName ??
        (table as unknown as { _?: { name?: string } })?._?.name ??
        "unknown";

      let returnId = "generic-uuid";
      if (name === "cases") returnId = CASE_UUID_INNER;
      else if (name === "claim_messages") returnId = CLAIM_MSG_UUID_INNER;

      return insertProxy(name, returnId)(/* call immediately with deferred values */);
    }),
    select: selectProxy(),
    update: vi.fn().mockImplementation((table: unknown) => {
      const name = (table as unknown as { tableName?: string }).tableName ??
        (table as unknown as { _?: { name?: string } })?._?.name ??
        "unknown";
      return updateProxy(name)();
    }),
    $count: vi.fn().mockResolvedValue(0),
  };

  // Override db.insert to be a passthrough to insertProxy that captures the
  // table reference so we can figure out the name. Because Drizzle table
  // objects carry their name in different ways depending on the version, we
  // handle both.
  db.insert = vi.fn().mockImplementation((table: unknown) => {
    const tbl = table as Record<string | symbol, unknown>;
    const drizzleNameSym = Symbol.for("drizzle:Name");
    const name =
      (tbl?.tableName as string | undefined) ??
      ((tbl?._ as Record<string, unknown>)?.name as string | undefined) ??
      (tbl?.[drizzleNameSym] as string | undefined) ??
      String(table);

    let returnId = "generic-uuid";
    if (name === "cases") returnId = CASE_UUID_INNER;
    else if (name === "claim_messages") returnId = CLAIM_MSG_UUID_INNER;
    else if (name === "claim_attachments") returnId = "attach-uuid-001";

    return {
      values: vi.fn().mockImplementation((values: unknown) => {
        const rows = Array.isArray(values) ? values : [values];
        for (const row of rows) {
          dbInserts.push({ table: name, values: row as Record<string, unknown> });
        }
        return {
          returning: vi.fn().mockResolvedValue([{ id: returnId }]),
          onConflictDoNothing: vi.fn().mockResolvedValue([]),
          onConflictDoUpdate: vi.fn().mockResolvedValue([]),
        };
      }),
    };
  });

  db.select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      }),
    }),
  });

  db.update = vi.fn().mockImplementation((table: unknown) => {
    const tbl = table as Record<string | symbol, unknown>;
    const drizzleNameSym = Symbol.for("drizzle:Name");
    const name =
      (tbl?.tableName as string | undefined) ??
      ((tbl?._ as Record<string, unknown>)?.name as string | undefined) ??
      (tbl?.[drizzleNameSym] as string | undefined) ??
      String(table);

    return {
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          dbUpdates.push({ table: name, values: {} });
          return Promise.resolve([]);
        }),
      }),
    };
  });

  return { db, tables: {} };
});

// Mock poll-state module entirely — its real implementation uses db directly.
vi.mock("@/server/email/gmail/poll-state", () => ({
  getOrCreatePollState: vi.fn(),
  advancePollState: vi.fn().mockResolvedValue(undefined),
  recordPollError: vi.fn().mockResolvedValue(undefined),
  getWatchExpiration: mockGetWatchExpiration,
}));

vi.mock("@/server/email/gmail/watch", () => ({
  setupGmailWatch: mockSetupGmailWatch,
}));

vi.mock("@/server/email/dedupe", () => ({
  checkDuplicate: vi.fn(),
}));

vi.mock("@/server/email/thread-lookup", () => ({
  threadLookup: vi.fn(),
}));

vi.mock("@/server/email/rehost-attachments", () => ({
  rehostAttachments: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/server/email/gmail/gmail-attachment-adapter", () => ({
  adaptGmailAttachments: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    EMAIL_RECEIVED: "email.received",
    ATTACHMENT_REHOSTED: "attachment.rehosted",
    ATTACHMENT_REJECTED: "attachment.rejected",
  },
}));

vi.mock("@/server/worker/extract", () => ({
  runExtractionWorker: vi.fn().mockResolvedValue(undefined),
}));

// Mock fetch so dispatchExtractionWorker doesn't hit the network.
vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

// ── Test constants ────────────────────────────────────────────────────────────

const TENANT_ID = "00000000-0000-0000-0000-000000000000"; // MVP sentinel
const MSG_ID_1 = "gmail-msg-001";
const MSG_ID_2 = "gmail-msg-002";
const THREAD_ID_1 = "gmail-thread-001";
const HISTORY_ID_START = "12345";
const HISTORY_ID_NEW = "12399";
const CASE_UUID = "case-uuid-test-001";
const CLAIM_MSG_UUID = "claim-msg-uuid-001";

// ── Gmail message builder ─────────────────────────────────────────────────────

/**
 * Build a minimal Gmail message object that matches gmail_v1.Schema$Message.
 */
function buildGmailMessage(opts: {
  id?: string;
  threadId?: string;
  inReplyTo?: string;
  subject?: string;
  from?: string;
  bodyText?: string;
  parts?: unknown[];
}) {
  const headers = [
    { name: "From", value: opts.from ?? "claimant@example.com" },
    { name: "To", value: "claims@company.com" },
    { name: "Subject", value: opts.subject ?? "Insurance Claim" },
    { name: "In-Reply-To", value: opts.inReplyTo ?? "" },
    { name: "References", value: "" },
    { name: "Date", value: new Date().toISOString() },
  ];

  // Encode body text in base64url
  const encodedBody = opts.bodyText
    ? Buffer.from(opts.bodyText).toString("base64url")
    : "";

  return {
    id: opts.id ?? MSG_ID_1,
    threadId: opts.threadId ?? THREAD_ID_1,
    historyId: HISTORY_ID_NEW,
    payload: {
      mimeType: "multipart/mixed",
      headers,
      body: {},
      parts: opts.parts ?? [
        {
          mimeType: "text/plain",
          headers: [],
          body: { data: encodedBody },
          filename: "",
        },
        {
          mimeType: "text/html",
          headers: [],
          body: { data: Buffer.from("<p>Hello</p>").toString("base64url") },
          filename: "",
        },
      ],
    },
  };
}

// ── Test setup ────────────────────────────────────────────────────────────────

/**
 * Wire the gmail mock to return history with messages.
 */
function setupGmailHistoryMock(messageIds: string[], historyId: string = HISTORY_ID_NEW) {
  mockGmailFn.mockReturnValue({
    users: {
      history: {
        list: mockHistoryList.mockResolvedValue({
          data: {
            historyId,
            history: messageIds.map((id) => ({
              messagesAdded: [{ message: { id } }],
            })),
          },
        }),
      },
      messages: {
        list: mockMessagesList,
        get: mockMessagesGet,
        modify: mockMessagesModify.mockResolvedValue({ data: {} }),
        attachments: {
          get: vi.fn().mockResolvedValue({ data: { data: "" } }),
        },
      },
      getProfile: mockGetProfile,
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("pollGmail — Gmail inbound polling pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear tracked DB calls between tests
    dbInserts.length = 0;
    dbUpdates.length = 0;

    // Default env
    process.env.GMAIL_USER_EMAIL = "claims@gmail.com";
    process.env.GMAIL_CLIENT_ID = "test-client-id";
    process.env.GMAIL_CLIENT_SECRET = "test-client-secret";
    process.env.GMAIL_REFRESH_TOKEN = "test-refresh-token";
    delete process.env.GMAIL_TENANT_ID;

    // Re-stub fetch after clearAllMocks
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(async () => {
    delete process.env.GMAIL_USER_EMAIL;
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.GMAIL_REFRESH_TOKEN;
    delete process.env.GMAIL_TENANT_ID;

    // Reset gmail-client singleton
    const { resetGmailAuth } = await import("@/server/email/gmail/gmail-client");
    resetGmailAuth();
  });

  // ── AC1: Happy-path ingest ───────────────────────────────────────────────────

  describe("AC1: happy-path ingest", () => {
    it("AC1: processes a new message and returns { processed: 1, skipped: 0, errors: 0 }", async () => {
      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_1]);

      const gmailMessage = buildGmailMessage({ id: MSG_ID_1, threadId: THREAD_ID_1 });
      mockMessagesGet.mockResolvedValue({ data: gmailMessage });

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { threadLookup } = await import("@/server/email/thread-lookup");
      (threadLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ existingCaseId: undefined });

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail();

      expect(result.processed).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.fallback).toBe(false);
    });

    it("AC1: inserts claim_messages row with correct fields (direction, provider, status)", async () => {
      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_1]);

      const gmailMessage = buildGmailMessage({
        id: MSG_ID_1,
        threadId: THREAD_ID_1,
        from: "claimant@example.com",
        subject: "My Claim",
        bodyText: "I had an accident",
      });
      mockMessagesGet.mockResolvedValue({ data: gmailMessage });

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { threadLookup } = await import("@/server/email/thread-lookup");
      (threadLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ existingCaseId: undefined });

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail();

      const claimMsgInserts = dbInserts.filter((r) => r.table === "claim_messages");
      expect(claimMsgInserts).toHaveLength(1);

      const row = claimMsgInserts[0].values;
      expect(row.direction).toBe("inbound");
      expect(row.provider).toBe("gmail");
      expect(row.status).toBe("received");
      expect(row.provider_message_id).toBe(MSG_ID_1);
      expect(row.thread_id).toBe(THREAD_ID_1);
      expect(row.tenant_id).toBe(TENANT_ID);
      expect(row.from_addr).toBe("claimant@example.com");
      expect(row.subject).toBe("My Claim");
    });

    it("AC1: body_text decoded correctly from base64url", async () => {
      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_1]);

      const bodyText = "I had an accident at Main Street.";
      const gmailMessage = buildGmailMessage({ id: MSG_ID_1, bodyText });
      mockMessagesGet.mockResolvedValue({ data: gmailMessage });

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { threadLookup } = await import("@/server/email/thread-lookup");
      (threadLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ existingCaseId: undefined });

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail();

      const claimMsgInserts = dbInserts.filter((r) => r.table === "claim_messages");
      expect(claimMsgInserts[0].values.body_text).toBe(bodyText);
    });
  });

  // ── AC2: Idempotent polling ──────────────────────────────────────────────────

  describe("AC2: idempotent polling (deduplication)", () => {
    it("AC2: skips already-seen messageId, returns { processed: 0, skipped: 1, errors: 0 }", async () => {
      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_1]);

      // checkDuplicate returns true → already seen
      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail();

      expect(result.processed).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors).toBe(0);
    });

    it("AC2: no claim_messages row inserted for duplicate message", async () => {
      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_1]);

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail();

      const claimMsgInserts = dbInserts.filter((r) => r.table === "claim_messages");
      expect(claimMsgInserts).toHaveLength(0);
    });
  });

  // ── AC3: Thread reply linked to existing case ────────────────────────────────

  describe("AC3: thread reply linked to existing case", () => {
    it("AC3: links claim_messages to existing case when In-Reply-To matches", async () => {
      const EXISTING_CASE_ID = "existing-case-uuid-001";

      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_2]);

      const gmailMessage = buildGmailMessage({
        id: MSG_ID_2,
        threadId: THREAD_ID_1,
        inReplyTo: "<" + MSG_ID_1 + "@mail.gmail.com>",
      });
      mockMessagesGet.mockResolvedValue({ data: gmailMessage });

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      // threadLookup returns existing case
      const { threadLookup } = await import("@/server/email/thread-lookup");
      (threadLookup as ReturnType<typeof vi.fn>).mockResolvedValue({
        existingCaseId: EXISTING_CASE_ID,
      });

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail();

      expect(result.processed).toBe(1);

      // claim_messages must reference the existing case
      const claimMsgInserts = dbInserts.filter((r) => r.table === "claim_messages");
      expect(claimMsgInserts).toHaveLength(1);
      expect(claimMsgInserts[0].values.case_id).toBe(EXISTING_CASE_ID);

      // No new case should be created
      const caseInserts = dbInserts.filter((r) => r.table === "cases");
      expect(caseInserts).toHaveLength(0);
    });

    it("AC3: in_reply_to stored without angle brackets", async () => {
      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_2]);

      const gmailMessage = buildGmailMessage({
        id: MSG_ID_2,
        inReplyTo: "<original-msg@gmail.com>",
      });
      mockMessagesGet.mockResolvedValue({ data: gmailMessage });

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { threadLookup } = await import("@/server/email/thread-lookup");
      (threadLookup as ReturnType<typeof vi.fn>).mockResolvedValue({
        existingCaseId: "existing-case-001",
      });

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail();

      const claimMsgInserts = dbInserts.filter((r) => r.table === "claim_messages");
      // Angle brackets must be stripped
      expect(claimMsgInserts[0].values.in_reply_to).toBe("original-msg@gmail.com");
    });
  });

  // ── AC4: headers and raw_payload persisted ───────────────────────────────────

  describe("AC4: headers array + raw_payload stored as jsonb", () => {
    it("AC4: headers array is stored on claim_messages row", async () => {
      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_1]);

      const gmailMessage = buildGmailMessage({ id: MSG_ID_1 });
      mockMessagesGet.mockResolvedValue({ data: gmailMessage });

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { threadLookup } = await import("@/server/email/thread-lookup");
      (threadLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ existingCaseId: undefined });

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail();

      const claimMsgInserts = dbInserts.filter((r) => r.table === "claim_messages");
      const row = claimMsgInserts[0].values;

      expect(Array.isArray(row.headers)).toBe(true);
      const headers = row.headers as Array<{ name: string; value: string }>;
      expect(headers.length).toBeGreaterThan(0);
      // Should contain the From header
      const fromHeader = headers.find((h) => h.name.toLowerCase() === "from");
      expect(fromHeader).toBeDefined();
    });

    it("AC4: raw_payload contains the full Gmail message JSON", async () => {
      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_1]);

      const gmailMessage = buildGmailMessage({ id: MSG_ID_1, threadId: THREAD_ID_1 });
      mockMessagesGet.mockResolvedValue({ data: gmailMessage });

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { threadLookup } = await import("@/server/email/thread-lookup");
      (threadLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ existingCaseId: undefined });

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail();

      const claimMsgInserts = dbInserts.filter((r) => r.table === "claim_messages");
      const rawPayload = claimMsgInserts[0].values.raw_payload as typeof gmailMessage;

      // raw_payload must be the verbatim Gmail message object
      expect(rawPayload.id).toBe(MSG_ID_1);
      expect(rawPayload.threadId).toBe(THREAD_ID_1);
      expect(rawPayload.payload).toBeDefined();
    });
  });

  // ── AC7: Watermark advances after successful batch ───────────────────────────

  describe("AC7: watermark advances after successful batch", () => {
    it("AC7: advancePollState called with new historyId after clean batch", async () => {
      const { getOrCreatePollState, advancePollState } = await import(
        "@/server/email/gmail/poll-state"
      );
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_1], HISTORY_ID_NEW);

      const gmailMessage = buildGmailMessage({ id: MSG_ID_1 });
      mockMessagesGet.mockResolvedValue({ data: gmailMessage });

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { threadLookup } = await import("@/server/email/thread-lookup");
      (threadLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ existingCaseId: undefined });

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail();

      expect(advancePollState).toHaveBeenCalledWith(
        "poll-state-uuid",
        HISTORY_ID_NEW
      );
    });

    it("AC7: history_id in response matches new watermark", async () => {
      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_1], HISTORY_ID_NEW);

      const gmailMessage = buildGmailMessage({ id: MSG_ID_1 });
      mockMessagesGet.mockResolvedValue({ data: gmailMessage });

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { threadLookup } = await import("@/server/email/thread-lookup");
      (threadLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ existingCaseId: undefined });

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail();

      expect(result.history_id).toBe(HISTORY_ID_NEW);
    });
  });

  // ── AC8: Watermark always advances when historyId moves forward ──────────────
  // (behavior: always advance to avoid permanent retry loops)

  describe("AC8: watermark advances even when all messages fail", () => {
    it("AC8: advancePollState IS called even when all messages error", async () => {
      const { getOrCreatePollState, advancePollState, recordPollError } = await import(
        "@/server/email/gmail/poll-state"
      );
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_1], HISTORY_ID_NEW);

      // messages.get throws — simulating a per-message failure
      mockMessagesGet.mockRejectedValue(new Error("ApiError"));

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail();

      expect(result.errors).toBe(1);
      expect(result.processed).toBe(0);

      // Watermark MUST advance so the same failing message isn't retried forever.
      expect(advancePollState).toHaveBeenCalledWith(
        "poll-state-uuid",
        HISTORY_ID_NEW
      );

      // Error must still be recorded per message
      expect(recordPollError).toHaveBeenCalled();
    });

    it("AC8: fallback mode — historyId stale → messages.list called, fallback=true in response", async () => {
      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: "old-stale-id",
      });

      // history.list returns 404
      const historyError = new Error("historyNotFound: 404");
      (historyError as unknown as { code: number }).code = 404;

      mockGmailFn.mockReturnValue({
        users: {
          history: {
            list: mockHistoryList.mockRejectedValue(historyError),
          },
          messages: {
            list: mockMessagesList.mockResolvedValue({
              data: { messages: [{ id: MSG_ID_1 }] },
            }),
            get: mockMessagesGet,
            modify: mockMessagesModify.mockResolvedValue({ data: {} }),
            attachments: { get: vi.fn() },
          },
          getProfile: mockGetProfile.mockResolvedValue({
            data: { historyId: "99999" },
          }),
        },
      });

      const gmailMessage = buildGmailMessage({ id: MSG_ID_1 });
      mockMessagesGet.mockResolvedValue({ data: gmailMessage });

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { threadLookup } = await import("@/server/email/thread-lookup");
      (threadLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ existingCaseId: undefined });

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail();

      expect(result.fallback).toBe(true);
      expect(mockMessagesList).toHaveBeenCalled();
    });
  });

  // ── AC10: Per-message error isolation ────────────────────────────────────────

  describe("AC10: per-message error isolation", () => {
    it("AC10: error on one message does not abort processing of subsequent messages", async () => {
      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      // Two messages in history
      setupGmailHistoryMock([MSG_ID_1, MSG_ID_2], HISTORY_ID_NEW);

      // MSG_ID_1 fails, MSG_ID_2 succeeds
      const goodMessage = buildGmailMessage({ id: MSG_ID_2, threadId: THREAD_ID_1 });
      mockMessagesGet
        .mockRejectedValueOnce(new Error("NetworkError")) // MSG_ID_1 fails
        .mockResolvedValueOnce({ data: goodMessage });     // MSG_ID_2 succeeds

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { threadLookup } = await import("@/server/email/thread-lookup");
      (threadLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ existingCaseId: undefined });

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail();

      // Both messages attempted: 1 error + 1 processed
      expect(result.errors).toBe(1);
      expect(result.processed).toBe(1);

      // MSG_ID_2 must have been inserted
      const claimMsgInserts = dbInserts.filter((r) => r.table === "claim_messages");
      expect(claimMsgInserts).toHaveLength(1);
      expect(claimMsgInserts[0].values.provider_message_id).toBe(MSG_ID_2);
    });

    it("AC10: no PII in error paths — only error code logged (not body/headers/from_addr)", async () => {
      // This test validates that the poller does not pass PII to recordPollError.
      const { getOrCreatePollState, recordPollError } = await import(
        "@/server/email/gmail/poll-state"
      );
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_1], HISTORY_ID_NEW);
      mockMessagesGet.mockRejectedValue(new Error("NetworkError"));

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail();

      // recordPollError should be called but the error string must not contain PII.
      expect(recordPollError).toHaveBeenCalled();
      const calls = (recordPollError as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of calls) {
        // recordPollError(id, errorString) — errorString is the second argument
        const errorStr = call[1] as string;
        // Must not contain email addresses or body content
        expect(errorStr).not.toMatch(/@example\.com/);
        expect(errorStr).not.toMatch(/accident/i);
        // Must contain the message ID for debugging
        expect(errorStr).toContain(MSG_ID_1);
      }
    });
  });

  // ── AC13: Attachment adapter called for messages with parts ──────────────────

  describe("AC13: attachment adapter called for messages with parts", () => {
    it("AC13: adaptGmailAttachments called with correct messageId and parts", async () => {
      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_1]);

      const attachmentPart = {
        filename: "policy.pdf",
        mimeType: "application/pdf",
        headers: [],
        body: { data: Buffer.from("PDF").toString("base64url") },
      };

      const gmailMessage = buildGmailMessage({
        id: MSG_ID_1,
        parts: [attachmentPart],
      });
      mockMessagesGet.mockResolvedValue({ data: gmailMessage });

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { threadLookup } = await import("@/server/email/thread-lookup");
      (threadLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ existingCaseId: undefined });

      const { adaptGmailAttachments } = await import(
        "@/server/email/gmail/gmail-attachment-adapter"
      );

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail();

      expect(adaptGmailAttachments).toHaveBeenCalledWith(
        expect.any(Array),
        MSG_ID_1,
        expect.any(Object) // gmail client
      );
    });
  });

  // ── AC14: Mark as read ────────────────────────────────────────────────────────

  describe("AC14: mark-as-read best-effort", () => {
    it("AC14: messages.modify called with removeLabelIds=[UNREAD] after successful insert", async () => {
      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_1]);

      const gmailMessage = buildGmailMessage({ id: MSG_ID_1 });
      mockMessagesGet.mockResolvedValue({ data: gmailMessage });

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { threadLookup } = await import("@/server/email/thread-lookup");
      (threadLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ existingCaseId: undefined });

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail();

      expect(mockMessagesModify).toHaveBeenCalledWith({
        userId: "me",
        id: MSG_ID_1,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });
    });

    it("AC14: mark-as-read failure is non-fatal — poll still returns processed=1", async () => {
      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      setupGmailHistoryMock([MSG_ID_1]);

      const gmailMessage = buildGmailMessage({ id: MSG_ID_1 });
      mockMessagesGet.mockResolvedValue({ data: gmailMessage });

      const { checkDuplicate } = await import("@/server/email/dedupe");
      (checkDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { threadLookup } = await import("@/server/email/thread-lookup");
      (threadLookup as ReturnType<typeof vi.fn>).mockResolvedValue({ existingCaseId: undefined });

      // mark-as-read fails
      mockMessagesModify.mockRejectedValue(new Error("ModifyError"));

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail();

      // Non-fatal — message still counted as processed
      expect(result.processed).toBe(1);
      expect(result.errors).toBe(0);
    });
  });

  // ── Empty batch ───────────────────────────────────────────────────────────────

  describe("empty batch", () => {
    it("returns { processed: 0, skipped: 0, errors: 0 } when no new messages", async () => {
      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_NEW,
      });

      mockGmailFn.mockReturnValue({
        users: {
          history: {
            list: mockHistoryList.mockResolvedValue({
              data: {
                historyId: HISTORY_ID_NEW,
                history: [],
              },
            }),
          },
          messages: {
            list: mockMessagesList,
            get: mockMessagesGet,
            modify: mockMessagesModify,
            attachments: { get: vi.fn() },
          },
          getProfile: mockGetProfile,
        },
      });

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail();

      expect(result.processed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);
    });
  });

  // ── Missing env vars ──────────────────────────────────────────────────────────

  describe("missing env vars", () => {
    it("returns errors=1 when GMAIL_USER_EMAIL is not set", async () => {
      delete process.env.GMAIL_USER_EMAIL;

      const { getOrCreatePollState } = await import("@/server/email/gmail/poll-state");
      (getOrCreatePollState as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "poll-state-uuid",
        historyId: HISTORY_ID_START,
      });

      mockGmailFn.mockReturnValue({
        users: {
          history: { list: mockHistoryList },
          messages: { list: mockMessagesList, get: mockMessagesGet, modify: mockMessagesModify, attachments: { get: vi.fn() } },
          getProfile: mockGetProfile,
        },
      });

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail();

      expect(result.errors).toBe(1);
      expect(result.processed).toBe(0);
    });
  });
});
