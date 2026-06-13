/**
 * Integration test for the cron route watch-renewal branch.
 *
 * AC9 (integration): When watch_expiration is within 24h, the cron route
 *   calls setupGmailWatch with PUBSUB_TOPIC, then calls pollAllGmailAccounts,
 *   and returns { watch_renewed: true } in the response body.
 *
 * All external I/O is mocked — no real DB, Gmail API, or network calls.
 * This test is kept in a separate file from gmail-poll.test.ts to avoid
 * module-mock conflicts: gmail-poll.test.ts tests pollGmail's real
 * implementation, while this file mocks pollAllGmailAccounts at the
 * route-handler level.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks (must precede all imports) ──────────────────────────────────

const {
  mockPollAllGmailAccounts,
  mockGetWatchExpiration,
  mockSetupGmailWatch,
  mockListEnabledGmailAccounts,
} = vi.hoisted(() => ({
  mockPollAllGmailAccounts: vi.fn(),
  mockGetWatchExpiration: vi.fn(),
  mockSetupGmailWatch: vi.fn(),
  mockListEnabledGmailAccounts: vi.fn(),
}));

vi.mock("@/server/email/gmail/gmail-poller", () => ({
  pollAllGmailAccounts: mockPollAllGmailAccounts,
  pollGmail: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
  tables: {},
}));

vi.mock("@/server/email/gmail/poll-state", () => ({
  getWatchExpiration: mockGetWatchExpiration,
  getOrCreatePollState: vi.fn(),
  advancePollState: vi.fn().mockResolvedValue(undefined),
  recordPollError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server/email/gmail/watch", () => ({
  setupGmailWatch: mockSetupGmailWatch,
}));

vi.mock("@/server/email/gmail/accounts", () => ({
  listEnabledGmailAccounts: mockListEnabledGmailAccounts,
}));

// ── Import route AFTER mocks ──────────────────────────────────────────────────

import { GET } from "@/app/api/cron/gmail-poll/route";

// ── Constants ─────────────────────────────────────────────────────────────────

const CRON_SECRET_VALUE = "integration-cron-secret-xyz";
const PUBSUB_TOPIC_VALUE = "projects/claimmix-test/topics/gmail-push";
const GMAIL_EMAIL_VALUE = "claims@integration.test";

const WATCH_RENEWAL_RESULT = {
  historyId: "789",
  expiration: "2026-06-11T12:00:00.000Z",
};

const POLL_ALL_RESULT = {
  accounts: 1,
  processed: 1,
  skipped: 0,
  errors: 0,
  results: [
    {
      processed: 1,
      skipped: 0,
      errors: 0,
      fallback: false,
      history_id: "99001",
      case_ids: [],
      account: GMAIL_EMAIL_VALUE,
    },
  ],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AC9 (integration) — cron route watch-renewal branch", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET_VALUE;
    process.env.PUBSUB_TOPIC = PUBSUB_TOPIC_VALUE;
    process.env.GMAIL_USER_EMAIL = GMAIL_EMAIL_VALUE;

    // No connected accounts in DB — falls back to GMAIL_USER_EMAIL env var.
    mockListEnabledGmailAccounts.mockResolvedValue([]);

    mockPollAllGmailAccounts.mockResolvedValue(POLL_ALL_RESULT);
    mockSetupGmailWatch.mockResolvedValue(WATCH_RENEWAL_RESULT);

    // Watch expires 12h from now — within the 24h renewal threshold (AC9).
    mockGetWatchExpiration.mockResolvedValue(
      new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    );

    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.PUBSUB_TOPIC;
    delete process.env.GMAIL_USER_EMAIL;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("AC9: renews watch and polls when expiration is within 24h threshold", async () => {
    const req = new NextRequest("http://localhost/api/cron/gmail-poll", {
      headers: { authorization: `Bearer ${CRON_SECRET_VALUE}` },
    });

    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);

    // setupGmailWatch must have been called with the PUBSUB_TOPIC value.
    expect(mockSetupGmailWatch).toHaveBeenCalledOnce();
    expect(mockSetupGmailWatch).toHaveBeenCalledWith(
      PUBSUB_TOPIC_VALUE,
      expect.objectContaining({ email: GMAIL_EMAIL_VALUE })
    );

    // pollAllGmailAccounts must also have been called (renewal does not skip polling).
    expect(mockPollAllGmailAccounts).toHaveBeenCalledOnce();

    // Response must flag that the watch was renewed.
    expect(body.watch_renewed).toBe(true);
  });
});
