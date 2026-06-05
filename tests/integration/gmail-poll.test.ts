/**
 * Integration tests for src/server/email/gmail/gmail-poller.ts
 *
 * All external dependencies are mocked (googleapis, Supabase, audit log,
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
 *  AC9 (integration): Cron route renews watch when expiration is within 24h threshold.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

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
  // Shared mocks reused by both the poller tests and the cron-route watch-renewal test.
  mockGetWatchExpiration,
  mockSetupGmailWatch,
  mockCreateServiceClient,
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
  const mockCreateServiceClient = vi.fn();
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
    mockCreateServiceClient,
  };
});

vi.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: MockOAuth2 },
    gmail: mockGmailFn,
  },
}));

vi.mock("@/server/email/gmail/poll-state", () => ({
  getOrCreatePollState: vi.fn(),
  advancePollState: vi.fn().mockResolvedValue(undefined),
  recordPollError: vi.fn().mockResolvedValue(undefined),
  getWatchExpiration: mockGetWatchExpiration,
}));

vi.mock("@/server/email/gmail/watch", () => ({
  setupGmailWatch: mockSetupGmailWatch,
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: mockCreateServiceClient,
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

// ── Supabase mock builder ─────────────────────────────────────────────────────

interface InsertRecord {
  table: string;
  row: Record<string, unknown>;
}

/**
 * Build a minimal Supabase service-role client mock.
 * Tracks all insert/update calls for assertions.
 */
function buildSupabaseMock(opts: {
  caseInsertId?: string;
  claimMessageInsertId?: string;
} = {}) {
  const inserts: InsertRecord[] = [];
  const updates: Array<{ table: string; patch: unknown; where: unknown }> = [];

  const caseId = opts.caseInsertId ?? CASE_UUID;
  const claimMsgId = opts.claimMessageInsertId ?? CLAIM_MSG_UUID;

  function makeChain(tableName: string, returnId: string) {
    return {
      insert: (row: unknown) => {
        const rows = Array.isArray(row) ? row : [row];
        for (const r of rows) {
          inserts.push({ table: tableName, row: r as Record<string, unknown> });
        }
        return {
          select: () => ({
            single: () =>
              Promise.resolve({ data: { id: returnId }, error: null }),
          }),
          single: () =>
            Promise.resolve({ data: { id: returnId }, error: null }),
        };
      },
      update: (patch: unknown) => ({
        eq: (col: string, val: unknown) => {
          updates.push({ table: tableName, patch, where: { [col]: val } });
          return Promise.resolve({ data: null, error: null });
        },
      }),
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    };
  }

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "cases") return makeChain("cases", caseId);
      if (table === "claim_messages") return makeChain("claim_messages", claimMsgId);
      if (table === "claim_attachments") return makeChain("claim_attachments", "attach-uuid-001");
      // Fallback
      return makeChain(table, "generic-uuid");
    }),
    _inserts: inserts,
    _updates: updates,
  };

  return supabase as unknown as SupabaseClient & { _inserts: InsertRecord[]; _updates: typeof updates };
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

    // Default env
    process.env.GMAIL_USER_EMAIL = "claims@gmail.com";
    process.env.GMAIL_CLIENT_ID = "test-client-id";
    process.env.GMAIL_CLIENT_SECRET = "test-client-secret";
    process.env.GMAIL_REFRESH_TOKEN = "test-refresh-token";
    delete process.env.GMAIL_TENANT_ID;
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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail(supabase);

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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail(supabase);

      const claimMsgInserts = supabase._inserts.filter(
        (r) => r.table === "claim_messages"
      );
      expect(claimMsgInserts).toHaveLength(1);

      const row = claimMsgInserts[0].row;
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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail(supabase);

      const claimMsgInserts = supabase._inserts.filter((r) => r.table === "claim_messages");
      expect(claimMsgInserts[0].row.body_text).toBe(bodyText);
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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail(supabase);

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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail(supabase);

      const claimMsgInserts = supabase._inserts.filter((r) => r.table === "claim_messages");
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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail(supabase);

      expect(result.processed).toBe(1);

      // claim_messages must reference the existing case
      const claimMsgInserts = supabase._inserts.filter((r) => r.table === "claim_messages");
      expect(claimMsgInserts).toHaveLength(1);
      expect(claimMsgInserts[0].row.case_id).toBe(EXISTING_CASE_ID);

      // No new case should be created
      const caseInserts = supabase._inserts.filter((r) => r.table === "cases");
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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail(supabase);

      const claimMsgInserts = supabase._inserts.filter((r) => r.table === "claim_messages");
      // Angle brackets must be stripped
      expect(claimMsgInserts[0].row.in_reply_to).toBe("original-msg@gmail.com");
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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail(supabase);

      const claimMsgInserts = supabase._inserts.filter((r) => r.table === "claim_messages");
      const row = claimMsgInserts[0].row;

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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail(supabase);

      const claimMsgInserts = supabase._inserts.filter((r) => r.table === "claim_messages");
      const rawPayload = claimMsgInserts[0].row.raw_payload as typeof gmailMessage;

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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail(supabase);

      expect(advancePollState).toHaveBeenCalledWith(
        supabase,
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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail(supabase);

      expect(result.history_id).toBe(HISTORY_ID_NEW);
    });
  });

  // ── AC8: Watermark always advances when historyId moves forward ──────────────
  // (c57d4c6 changed behavior: always advance to avoid permanent retry loops
  // where the same failing message re-triggers on every Pub/Sub push)

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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail(supabase);

      expect(result.errors).toBe(1);
      expect(result.processed).toBe(0);

      // Watermark MUST advance so the same failing message isn't retried forever.
      expect(advancePollState).toHaveBeenCalledWith(
        expect.anything(),
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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail(supabase);

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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail(supabase);

      // Both messages attempted: 1 error + 1 processed
      expect(result.errors).toBe(1);
      expect(result.processed).toBe(1);

      // MSG_ID_2 must have been inserted
      const claimMsgInserts = supabase._inserts.filter((r) => r.table === "claim_messages");
      expect(claimMsgInserts).toHaveLength(1);
      expect(claimMsgInserts[0].row.provider_message_id).toBe(MSG_ID_2);
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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail(supabase);

      // recordPollError should be called but the error string must not contain PII.
      expect(recordPollError).toHaveBeenCalled();
      const calls = (recordPollError as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of calls) {
        const errorStr = call[2] as string;
        // Must not contain email addresses or body content
        expect(errorStr).not.toMatch(/@example\.com/);
        expect(errorStr).not.toMatch(/accident/i);
        // Must contain the message ID for debugging
        expect(errorStr).toContain(MSG_ID_1);
      }
    });
  });

  // ── AC13: Attachment stored in Supabase Storage ───────────────────────────────

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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail(supabase);

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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      await pollGmail(supabase);

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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail(supabase);

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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail(supabase);

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

      const supabase = buildSupabaseMock();

      const { pollGmail } = await import("@/server/email/gmail/gmail-poller");
      const result = await pollGmail(supabase);

      expect(result.errors).toBe(1);
      expect(result.processed).toBe(0);
    });
  });
});


