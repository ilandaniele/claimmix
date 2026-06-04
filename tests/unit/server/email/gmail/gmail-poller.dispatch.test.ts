/**
 * Unit tests for dispatchExtractionWorker() behaviour in gmail-poller.ts.
 *
 * AC5: Gmail poller dispatches via fetch POST to /api/worker/extract with
 *      X-Internal-Worker: true header and JSON body { caseId, tenantId }.
 * AC6: Dispatch error is logged (name + caseId, no PII) and does NOT crash the
 *      poll loop; subsequent messages are still processed.
 * NB3: New case insert uses claim_type: null (not a hard-coded string) so that
 *      cases where extraction fails are detectable by the reprocess endpoint's
 *      `claim_type IS NULL` filter.
 *
 * Strategy:
 *   - Mock all heavy dependencies (supabase, gmail client, server-only, etc.)
 *     so we can call processMessage() indirectly via pollGmail().
 *   - Replace global.fetch with a vi.fn() and assert its call signature.
 *   - Simulate fetch rejection to verify error isolation (AC6).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoist mock factories BEFORE any imports ───────────────────────────────────

const {
  mockGetWorkerBaseUrl,
  mockGetGmailClient,
  mockGetOrCreatePollState,
  mockAdvancePollState,
  mockRecordPollError,
  mockAdaptGmailAttachments,
  mockCheckDuplicate,
  mockThreadLookup,
  mockRehostAttachments,
  mockWriteAuditLog,
} = vi.hoisted(() => ({
  mockGetWorkerBaseUrl: vi.fn().mockReturnValue("http://localhost:3000"),
  mockGetGmailClient: vi.fn(),
  mockGetOrCreatePollState: vi.fn(),
  mockAdvancePollState: vi.fn().mockResolvedValue(undefined),
  mockRecordPollError: vi.fn().mockResolvedValue(undefined),
  mockAdaptGmailAttachments: vi.fn().mockResolvedValue([]),
  mockCheckDuplicate: vi.fn().mockResolvedValue(false),
  mockThreadLookup: vi.fn().mockResolvedValue({ existingCaseId: null }),
  mockRehostAttachments: vi.fn().mockResolvedValue([]),
  mockWriteAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("server-only", () => ({}));

vi.mock("@/server/email/dispatch-url", () => ({
  getWorkerBaseUrl: mockGetWorkerBaseUrl,
}));

vi.mock("@/server/email/gmail/gmail-client", () => ({
  getGmailClient: mockGetGmailClient,
}));

vi.mock("@/server/email/gmail/poll-state", () => ({
  getOrCreatePollState: mockGetOrCreatePollState,
  advancePollState: mockAdvancePollState,
  recordPollError: mockRecordPollError,
}));

vi.mock("@/server/email/gmail/gmail-attachment-adapter", () => ({
  adaptGmailAttachments: mockAdaptGmailAttachments,
}));

vi.mock("@/server/email/dedupe", () => ({
  checkDuplicate: mockCheckDuplicate,
}));

vi.mock("@/server/email/thread-lookup", () => ({
  threadLookup: mockThreadLookup,
}));

vi.mock("@/server/email/rehost-attachments", () => ({
  rehostAttachments: mockRehostAttachments,
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockWriteAuditLog,
  AuditEvent: {
    EMAIL_RECEIVED: "EMAIL_RECEIVED",
    ATTACHMENT_REHOSTED: "ATTACHMENT_REHOSTED",
    ATTACHMENT_REJECTED: "ATTACHMENT_REJECTED",
  },
}));

// ── Import SUT after mocks ────────────────────────────────────────────────────

import { pollGmail } from "@/server/email/gmail/gmail-poller";

// ── Test constants ────────────────────────────────────────────────────────────

const TENANT_ID = "00000000-0000-0000-0000-000000000000";
const CASE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const MSG_ID = "gmail-msg-id-001";

/** Minimal Supabase mock that returns a new case UUID on cases.insert */
function makeSupabaseMock(overrides?: {
  casesInsertError?: { code: string } | null;
  messagesInsertError?: { code: string } | null;
}): any {
  const casesInsertError = overrides?.casesInsertError ?? null;
  const messagesInsertError = overrides?.messagesInsertError ?? null;

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "cases") {
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: casesInsertError ? null : { id: CASE_ID },
                error: casesInsertError,
              }),
            }),
          }),
        };
      }
      if (table === "claim_messages") {
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: messagesInsertError ? null : { id: "claim-msg-uuid-001" },
                error: messagesInsertError,
              }),
            }),
          }),
        };
      }
      // Default: no-op for other tables
      return {
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: "other-uuid" }, error: null }),
          }),
        }),
      };
    }),
  };
}

/**
 * Build a minimal Gmail client mock that returns a single message when
 * users.messages.get is called.
 */
function makeGmailMock(messageId = MSG_ID) {
  const mockMessage = {
    id: messageId,
    threadId: "thread-001",
    historyId: "99999",
    payload: {
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "claims@claimmix.com" },
        { name: "Subject", value: "Test subject" },
        { name: "In-Reply-To", value: "" },
        { name: "References", value: "" },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from("Hello").toString("base64url") },
      parts: [],
    },
  };

  return {
    users: {
      history: {
        list: vi.fn().mockResolvedValue({
          data: {
            historyId: "99999",
            history: [{ messagesAdded: [{ message: { id: messageId } }] }],
          },
        }),
      },
      messages: {
        get: vi.fn().mockResolvedValue({ data: mockMessage }),
        modify: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

/** Build a minimal poll state mock. */
function makePollState(historyId = "12345") {
  return { id: "poll-state-uuid", historyId };
}

// ── Shared setup ──────────────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  originalFetch = globalThis.fetch;

  // Env vars
  process.env.GMAIL_USER_EMAIL = "claims@claimmix.com";
  delete process.env.GMAIL_TENANT_ID; // use sentinel

  // Default mock returns
  mockGetWorkerBaseUrl.mockReturnValue("http://localhost:3000");
  mockGetOrCreatePollState.mockResolvedValue(makePollState());
  mockCheckDuplicate.mockResolvedValue(false);
  mockThreadLookup.mockResolvedValue({ existingCaseId: null });
  mockAdaptGmailAttachments.mockResolvedValue([]);
  mockWriteAuditLog.mockResolvedValue(undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GMAIL_USER_EMAIL;
  delete process.env.GMAIL_TENANT_ID;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("dispatchExtractionWorker — AC5: fetch POST with correct shape", () => {
  it("calls fetch with POST method and X-Internal-Worker: true header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    const gmailMock = makeGmailMock();
    mockGetGmailClient.mockReturnValue(gmailMock);

    const supabase = makeSupabaseMock();
    await pollGmail(supabase);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("http://localhost:3000/api/worker/extract");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Internal-Worker"]).toBe("true");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("sends JSON body with caseId and tenantId", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    const gmailMock = makeGmailMock();
    mockGetGmailClient.mockReturnValue(gmailMock);

    const supabase = makeSupabaseMock();
    await pollGmail(supabase);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body).toMatchObject({
      caseId: CASE_ID,
      tenantId: TENANT_ID,
    });
  });

  it("uses the base URL returned by getWorkerBaseUrl (AC7 integration)", async () => {
    mockGetWorkerBaseUrl.mockReturnValue("https://my-project.vercel.app");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    const gmailMock = makeGmailMock();
    mockGetGmailClient.mockReturnValue(gmailMock);

    const supabase = makeSupabaseMock();
    await pollGmail(supabase);

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://my-project.vercel.app/api/worker/extract");
  });

  it("dispatches once per successfully processed message", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    // Return two distinct message IDs from history
    const gmail = makeGmailMock();
    (gmail.users.history.list as any).mockResolvedValue({
      data: {
        historyId: "99999",
        history: [
          {
            messagesAdded: [
              { message: { id: "msg-001" } },
              { message: { id: "msg-002" } },
            ],
          },
        ],
      },
    });

    // Return a valid message object for both IDs
    const mockMsg = (id: string) => ({
      id,
      threadId: "thread-001",
      historyId: "99999",
      payload: {
        headers: [
          { name: "From", value: "sender@example.com" },
          { name: "To", value: "claims@claimmix.com" },
          { name: "Subject", value: "Subject" },
          { name: "In-Reply-To", value: "" },
          { name: "References", value: "" },
        ],
        mimeType: "text/plain",
        body: { data: "" },
        parts: [],
      },
    });
    (gmail.users.messages.get as any)
      .mockResolvedValueOnce({ data: mockMsg("msg-001") })
      .mockResolvedValueOnce({ data: mockMsg("msg-002") });

    mockGetGmailClient.mockReturnValue(gmail);

    // Return distinct case IDs for each insert
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "cases") {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi
                  .fn()
                  .mockResolvedValueOnce({ data: { id: "case-001" }, error: null })
                  .mockResolvedValueOnce({ data: { id: "case-002" }, error: null }),
              }),
            }),
          };
        }
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: "msg-row-uuid" }, error: null }),
            }),
          }),
        };
      }),
    };

    await pollGmail(supabase);

    // fetch called once per processed message
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("dispatchExtractionWorker — AC6: error isolation", () => {
  it("does not throw when fetch rejects; pollGmail still returns processed: 1", async () => {
    // fetch rejects (network error / DNS failure)
    const networkError = new TypeError("fetch failed");
    const mockFetch = vi.fn().mockRejectedValue(networkError);
    globalThis.fetch = mockFetch;

    const gmailMock = makeGmailMock();
    mockGetGmailClient.mockReturnValue(gmailMock);

    const supabase = makeSupabaseMock();
    const result = await pollGmail(supabase);

    // Poll loop must not crash — message is processed (claim row inserted)
    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("logs the error name and caseId but NOT the full error object (no PII)", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const networkError = new TypeError("Network Error containing user PII");
    const mockFetch = vi.fn().mockRejectedValue(networkError);
    globalThis.fetch = mockFetch;

    const gmailMock = makeGmailMock();
    mockGetGmailClient.mockReturnValue(gmailMock);

    const supabase = makeSupabaseMock();
    await pollGmail(supabase);

    // Wait a tick for the .catch() to run
    await new Promise((r) => setTimeout(r, 0));

    // Find the dispatch error log
    const dispatchErrorCall = consoleErrorSpy.mock.calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("[gmail-poller] Worker dispatch error:")
    );

    expect(dispatchErrorCall).toBeDefined();

    // Should log the error name ("TypeError")
    expect(dispatchErrorCall).toContain("TypeError");

    // Should log the caseId
    expect(dispatchErrorCall).toContain(CASE_ID);

    // Should NOT log the full message text (which could contain PII)
    const loggedText = dispatchErrorCall!.join(" ");
    expect(loggedText).not.toContain("Network Error containing user PII");

    consoleErrorSpy.mockRestore();
  });

  it("processes subsequent messages even after a dispatch failure on the first", async () => {
    // First fetch call fails, second succeeds
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: true });
    globalThis.fetch = mockFetch;

    const gmail = makeGmailMock();
    (gmail.users.history.list as any).mockResolvedValue({
      data: {
        historyId: "99999",
        history: [
          {
            messagesAdded: [
              { message: { id: "msg-001" } },
              { message: { id: "msg-002" } },
            ],
          },
        ],
      },
    });

    const mockMsg = (id: string) => ({
      id,
      threadId: "thread-001",
      historyId: "99999",
      payload: {
        headers: [
          { name: "From", value: "a@b.com" },
          { name: "To", value: "c@d.com" },
          { name: "Subject", value: "S" },
          { name: "In-Reply-To", value: "" },
          { name: "References", value: "" },
        ],
        mimeType: "text/plain",
        body: { data: "" },
        parts: [],
      },
    });
    (gmail.users.messages.get as any)
      .mockResolvedValueOnce({ data: mockMsg("msg-001") })
      .mockResolvedValueOnce({ data: mockMsg("msg-002") });

    mockGetGmailClient.mockReturnValue(gmail);

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "cases") {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi
                  .fn()
                  .mockResolvedValueOnce({ data: { id: "case-001" }, error: null })
                  .mockResolvedValueOnce({ data: { id: "case-002" }, error: null }),
              }),
            }),
          };
        }
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: "msg-row-uuid" }, error: null }),
            }),
          }),
        };
      }),
    };

    const result = await pollGmail(supabase);

    // Both messages processed — dispatch error on first did not abort the loop
    expect(result.processed).toBe(2);
    expect(result.errors).toBe(0);

    // fetch was still called for both messages
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("NB3 — initial case insert uses claim_type: null", () => {
  it("inserts the new case row with claim_type: null (not a hard-coded string)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    const gmailMock = makeGmailMock();
    mockGetGmailClient.mockReturnValue(gmailMock);

    // Build a supabase mock that captures the insert payload for 'cases'.
    let capturedInsertPayload: unknown = undefined;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "cases") {
          return {
            insert: vi.fn().mockImplementation((payload: unknown) => {
              capturedInsertPayload = payload;
              return {
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: { id: CASE_ID }, error: null }),
                }),
              };
            }),
          };
        }
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: "claim-msg-uuid" }, error: null }),
            }),
          }),
        };
      }),
    };

    await pollGmail(supabase);

    // The insert payload must NOT carry a hard-coded claim_type value.
    expect(capturedInsertPayload).toBeDefined();
    expect((capturedInsertPayload as Record<string, unknown>).claim_type).toBeNull();
  });
});
