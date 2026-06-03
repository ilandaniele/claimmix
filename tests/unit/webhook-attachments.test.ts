/**
 * Unit tests for AC23: claim_attachments insertion in the webhook route handler.
 *
 * AC23: Attachments stored separately and PII-protected — claim_attachments
 *       rows with original_filename, content_type, size_bytes;
 *       URLs not logged to stdout.
 *
 * W6 update: attachment insertion now goes through the rehost pipeline
 * (rehostAttachments → individual inserts with original_filename, storage_path,
 * content_hash, rejected_reason, claim_message_id). The old bulk-insert path
 * with file_name/external_url is replaced by the rehost service.
 *
 * These tests verify:
 *   1. Payload with 2 attachments → 2 individual claim_attachments rows inserted.
 *   2. Payload with no attachments → no claim_attachments inserts, no error.
 *   3. Attachment ContentURL is NOT logged to console.log (PII protection).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock HMAC verification to always succeed (so we can reach the attachment logic).
vi.mock("@/server/email/verify-postmark-signature", () => ({
  verifyPostmarkSignature: vi.fn().mockReturnValue({ valid: true }),
}));

// Mock deduplication to always return fresh (no duplicate).
// Also export normalizeMessageId since route.ts imports it from the same module.
vi.mock("@/server/email/dedupe", () => ({
  dedupe: vi.fn().mockResolvedValue({ isDuplicate: false, existingCaseId: null }),
  normalizeMessageId: (s: string) => s.trim().replace(/^<+/, "").replace(/>+$/, "").trim(),
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
    ATTACHMENT_REHOSTED: "attachment.rehosted",
    ATTACHMENT_REJECTED: "attachment.rejected",
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

// W6: Mock storage bucket so no real Supabase calls are made.
const mockUploadAttachment = vi.fn();
vi.mock("@/server/storage/claim-attachments-bucket", () => ({
  uploadAttachment: (...args: any[]) => mockUploadAttachment(...args),
  computeContentHash: (data: Buffer) =>
    createHash("sha256").update(data).digest("hex"),
  createStorageClient: vi.fn(),
}));

// ── Supabase service client mock ──────────────────────────────────────────────

const CASE_ID = "case-uuid-1234";
const CLAIM_MSG_ID = "claim-msg-uuid-001";

/**
 * Build a mock Supabase service client.
 *
 * W6 update: claim_attachments mock now supports both:
 *   - select().eq().eq().limit().maybeSingle() — dedupe query in rehostAttachments
 *   - insert() — individual row insert from processAttachments
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
                  data: { id: CASE_ID },
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
          // Dedupe SELECT query (returns no existing row by default).
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }),
          // Individual row insert (W6 — called once per attachment).
          insert: (data: any) => attachmentInsertSpy(data),
        };
      }
      if (table === "audit_log") {
        return {
          insert: (_data: any) => Promise.resolve({ error: null }),
        };
      }
      // claim_messages: dual-write path — must support .insert().select().single()
      if (table === "claim_messages") {
        return {
          insert: (_data: any) => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: CLAIM_MSG_ID }, error: null }),
            }),
          }),
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
    process.env.DEFAULT_TENANT_ID = "tenant-uuid-0001";
    process.env.POSTMARK_WEBHOOK_SECRET = "test-secret";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";

    attachmentInsertSpy = vi.fn().mockResolvedValue({ error: null });

    // uploadAttachment succeeds by default — returns a fake storage path.
    mockUploadAttachment.mockResolvedValue({
      storagePath: `tenant-uuid-0001/${CASE_ID}/${CLAIM_MSG_ID}/abc-file.pdf`,
    });

    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DEFAULT_TENANT_ID;
    delete process.env.POSTMARK_WEBHOOK_SECRET;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("inserts 2 claim_attachments rows when payload has 2 attachments", async () => {
    const mockClient = buildMockServiceClient({ attachmentInsertSpy });

    vi.doMock("@/lib/supabase/service", () => ({
      createServiceClient: () => mockClient,
    }));

    const pdf1Content = Buffer.from("pdf1 content").toString("base64");
    const jpg1Content = Buffer.from("jpg1 content").toString("base64");

    const body = makePostmarkPayload({
      Attachments: [
        {
          Name: "denuncia.pdf",
          Content: pdf1Content,
          ContentType: "application/pdf",
          ContentLength: Buffer.from(pdf1Content, "base64").length,
          ContentURL: "https://phcdn.postmarkapp.com/attachment/abc123",
          ContentID: "",
        },
        {
          Name: "foto-danios.jpg",
          Content: jpg1Content,
          ContentType: "image/jpeg",
          ContentLength: Buffer.from(jpg1Content, "base64").length,
          ContentURL: "https://phcdn.postmarkapp.com/attachment/def456",
          ContentID: "",
        },
      ],
    });

    const { POST } = await import("@/app/api/intake/email/route");
    const request = makeRequest(body);
    const response = await POST(request as any);

    expect(response.status).toBe(202);

    // W6: attachmentInsertSpy is called once per attachment (individual inserts).
    expect(attachmentInsertSpy).toHaveBeenCalledTimes(2);

    // Verify first row — uses new column names from W6.
    const row1 = attachmentInsertSpy.mock.calls[0]![0] as any;
    expect(row1.case_id).toBe(CASE_ID);
    expect(row1.original_filename).toBe("denuncia.pdf");
    expect(row1.content_type).toBe("application/pdf");
    expect(row1.claim_message_id).toBe(CLAIM_MSG_ID);
    // storage_path is set (upload succeeded).
    expect(row1.storage_path).toBeTruthy();
    expect(row1.rejected_reason).toBeNull();

    // Verify second row.
    const row2 = attachmentInsertSpy.mock.calls[1]![0] as any;
    expect(row2.case_id).toBe(CASE_ID);
    expect(row2.original_filename).toBe("foto-danios.jpg");
    expect(row2.content_type).toBe("image/jpeg");
  });

  it("does not call claim_attachments insert when Attachments array is empty", async () => {
    const mockClient = buildMockServiceClient({ attachmentInsertSpy });

    vi.doMock("@/lib/supabase/service", () => ({
      createServiceClient: () => mockClient,
    }));

    const body = makePostmarkPayload({ Attachments: [] });

    const { POST } = await import("@/app/api/intake/email/route");
    const request = makeRequest(body);
    const response = await POST(request as any);

    expect(response.status).toBe(202);
    expect(attachmentInsertSpy).not.toHaveBeenCalled();
  });

  it("does not log attachment ContentURL to console.log (PII protection, AC23)", async () => {
    const attachmentURL = "https://phcdn.postmarkapp.com/attachment/secret-url-pii";
    const mockClient = buildMockServiceClient({ attachmentInsertSpy });

    vi.doMock("@/lib/supabase/service", () => ({
      createServiceClient: () => mockClient,
    }));

    const pdfContent = Buffer.from("pdf content").toString("base64");
    const body = makePostmarkPayload({
      Attachments: [
        {
          Name: "poliza.pdf",
          Content: pdfContent,
          ContentType: "application/pdf",
          ContentLength: Buffer.from(pdfContent, "base64").length,
          ContentURL: attachmentURL,
          ContentID: "",
        },
      ],
    });

    const { POST } = await import("@/app/api/intake/email/route");
    const request = makeRequest(body);
    await POST(request as any);

    const logCalls = consoleSpy.mock.calls.map((call) =>
      call.map(String).join(" ")
    );
    const urlLeaked = logCalls.some((msg) => msg.includes(attachmentURL));
    expect(urlLeaked).toBe(false);
  });
});
