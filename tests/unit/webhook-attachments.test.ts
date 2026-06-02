/**
 * Unit tests for AC23: claim_attachments insertion in the webhook route handler.
 *
 * AC23: Attachments stored separately and PII-protected — claim_attachments
 *       rows with filename, content_type, size_bytes, external_url;
 *       URLs not logged to stdout.
 *
 * These tests verify:
 *   1. Payload with 2 attachments → 2 claim_attachments rows inserted.
 *   2. Payload with no attachments → no claim_attachments inserts, no error.
 *   3. Attachment ContentURL is NOT logged to console.log (PII protection).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock HMAC verification to always succeed (so we can reach the attachment logic).
vi.mock("@/server/email/verify-postmark-signature", () => ({
  verifyPostmarkSignature: vi.fn().mockReturnValue({ valid: true }),
}));

// Mock deduplication to always return fresh (no duplicate).
vi.mock("@/server/email/dedupe", () => ({
  dedupe: vi.fn().mockResolvedValue({ isDuplicate: false, existingCaseId: null }),
}));

// Mock thread lookup to return no existing thread (new case path).
vi.mock("@/server/email/thread-lookup", () => ({
  threadLookup: vi.fn().mockResolvedValue({ existingCaseId: null }),
}));

// Mock audit log to avoid DB writes.
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    EMAIL_RECEIVED: "email.received",
    WEBHOOK_REJECTED: "webhook.rejected",
  },
}));

// Mock the extraction worker dispatch to be a no-op.
vi.mock("@/server/worker/extract", () => ({
  runExtractionWorker: vi.fn().mockResolvedValue(undefined),
  runEmailExtractionWorker: vi.fn().mockResolvedValue(undefined),
}));

// Mock rate limiter to always allow.
vi.mock("@/lib/rate-limit/index", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
  rateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  RATE_LIMIT_CONFIGS: {
    EMAIL_INTAKE_WEBHOOK: { limit: 100, windowMs: 10_000 },
  },
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
  buildUserKey: vi.fn((id: string, key: string) => `${id}:${key}`),
}));

// ── Supabase service client mock ──────────────────────────────────────────────

/**
 * Build a mock Supabase service client.
 *
 * We track calls to .from("claim_attachments").insert(...) to verify AC23.
 */
function buildMockServiceClient({
  attachmentInsertSpy = vi.fn().mockResolvedValue({ error: null }),
} = {}) {
  return {
    from: (table: string) => {
      if (table === "cases") {
        return {
          insert: (_data: any) => ({
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: "case-uuid-1234" },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "raw_messages") {
        return {
          insert: (_data: any) => Promise.resolve({ error: null }),
        };
      }
      if (table === "claim_attachments") {
        return {
          insert: (data: any) => attachmentInsertSpy(data),
        };
      }
      if (table === "audit_log") {
        return {
          insert: (_data: any) => Promise.resolve({ error: null }),
        };
      }
      return {
        insert: (_data: any) => Promise.resolve({ error: null }),
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      };
    },
  };
}

// ── Minimal valid Postmark payload factory ────────────────────────────────────

function makePostmarkPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    MessageID: `msg-${Date.now()}`,
    FromFull: { Email: "claimant@example.com", Name: "Juan Pérez", MailboxHash: "" },
    From: "Juan Pérez <claimant@example.com>",
    ToFull: [{ Email: "claims@claimmix.com", Name: "ClaimMix", MailboxHash: "" }],
    To: "claims@claimmix.com",
    CcFull: [],
    BccFull: [],
    Subject: "Siniestro de choque",
    TextBody: "Tuve un choque en Av. Cabildo.",
    HtmlBody: "",
    StrippedTextReply: "",
    InReplyTo: "",
    References: "",
    Date: "Mon, 02 Jun 2026 10:00:00 -0300",
    Tag: "",
    MailboxHash: "",
    Headers: [],
    Attachments: [],
    OriginalRecipient: "claims@claimmix.com",
    ...overrides,
  });
}

// ── Request factory ───────────────────────────────────────────────────────────

function makeRequest(body: string): Request {
  return new Request("http://localhost/api/intake/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // A non-empty header so the mock verifier receives something to validate.
      "x-postmark-signature": "mock-valid-signature",
      "x-forwarded-for": "127.0.0.1",
    },
    body,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Webhook route — AC23 claim_attachments insertion", () => {
  let attachmentInsertSpy: ReturnType<typeof vi.fn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset env so DEFAULT_TENANT_ID is available.
    process.env.DEFAULT_TENANT_ID = "tenant-uuid-0001";
    process.env.POSTMARK_WEBHOOK_SECRET = "test-secret";

    attachmentInsertSpy = vi.fn().mockResolvedValue({ error: null });

    // Intercept console.log to detect URL leakage.
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Allow console.error (used for non-fatal errors) to pass through so
    // we can detect unexpected failures; only block log.
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DEFAULT_TENANT_ID;
    delete process.env.POSTMARK_WEBHOOK_SECRET;
  });

  it("inserts 2 claim_attachments rows when payload has 2 attachments", async () => {
    const mockClient = buildMockServiceClient({ attachmentInsertSpy });

    // Inject our mock client into the service module.
    vi.doMock("@/lib/supabase/service", () => ({
      createServiceClient: () => mockClient,
    }));

    const body = makePostmarkPayload({
      Attachments: [
        {
          Name: "denuncia.pdf",
          Content: "",
          ContentType: "application/pdf",
          ContentLength: 102400,
          ContentURL: "https://phcdn.postmarkapp.com/attachment/abc123",
          ContentID: "",
        },
        {
          Name: "foto-danios.jpg",
          Content: "",
          ContentType: "image/jpeg",
          ContentLength: 204800,
          ContentURL: "https://phcdn.postmarkapp.com/attachment/def456",
          ContentID: "",
        },
      ],
    });

    // Dynamically import the route handler so the mocks are in place.
    const { POST } = await import("@/app/api/intake/email/route");
    const request = makeRequest(body);
    const response = await POST(request as any);

    // Route should return 202.
    expect(response.status).toBe(202);

    // claim_attachments insert should have been called once with 2 rows.
    expect(attachmentInsertSpy).toHaveBeenCalledTimes(1);
    const insertedRows = attachmentInsertSpy.mock.calls[0]![0] as any[];
    expect(insertedRows).toHaveLength(2);

    // Verify row 1 contents.
    expect(insertedRows[0]).toMatchObject({
      case_id: "case-uuid-1234",
      file_name: "denuncia.pdf",
      content_type: "application/pdf",
      size_bytes: 102400,
    });
    expect(insertedRows[0].external_url).toBe(
      "https://phcdn.postmarkapp.com/attachment/abc123"
    );

    // Verify row 2 contents.
    expect(insertedRows[1]).toMatchObject({
      case_id: "case-uuid-1234",
      file_name: "foto-danios.jpg",
      content_type: "image/jpeg",
      size_bytes: 204800,
    });
  });

  it("does not call claim_attachments insert when Attachments array is empty", async () => {
    const mockClient = buildMockServiceClient({ attachmentInsertSpy });

    vi.doMock("@/lib/supabase/service", () => ({
      createServiceClient: () => mockClient,
    }));

    // Payload with no attachments (empty array).
    const body = makePostmarkPayload({ Attachments: [] });

    const { POST } = await import("@/app/api/intake/email/route");
    const request = makeRequest(body);
    const response = await POST(request as any);

    // Route should return 202 without error.
    expect(response.status).toBe(202);

    // claim_attachments insert must NOT have been called.
    expect(attachmentInsertSpy).not.toHaveBeenCalled();
  });

  it("does not log attachment ContentURL to console.log (PII protection, AC23)", async () => {
    const attachmentURL = "https://phcdn.postmarkapp.com/attachment/secret-url-pii";
    const mockClient = buildMockServiceClient({ attachmentInsertSpy });

    vi.doMock("@/lib/supabase/service", () => ({
      createServiceClient: () => mockClient,
    }));

    const body = makePostmarkPayload({
      Attachments: [
        {
          Name: "poliza.pdf",
          Content: "",
          ContentType: "application/pdf",
          ContentLength: 51200,
          ContentURL: attachmentURL,
          ContentID: "",
        },
      ],
    });

    const { POST } = await import("@/app/api/intake/email/route");
    const request = makeRequest(body);
    await POST(request as any);

    // Verify the attachment URL was never passed to console.log.
    const logCalls = consoleSpy.mock.calls.map((call) =>
      call.map(String).join(" ")
    );
    const urlLeaked = logCalls.some((msg) => msg.includes(attachmentURL));
    expect(urlLeaked).toBe(false);
  });
});
