/**
 * Integration tests for attachment rehost — POST /api/intake/email (W6).
 *
 * Tests the full path: webhook → claim_messages insert → rehostAttachments()
 * → claim_attachments rows → audit log events.
 *
 * Uses mocked Supabase client (no live DB), mocked Storage (no live bucket),
 * and mocked HMAC / rate-limit to isolate the attachment logic.
 *
 * AC7:  Valid PDF attachment → claim_attachments row with content_hash +
 *       storage_path matching pattern + ATTACHMENT_REHOSTED audit event.
 * AC8:  application/x-msdownload → rejected_reason='content_type_not_allowed',
 *       no storage upload, ATTACHMENT_REJECTED audit event.
 * AC9:  11 MB attachment → rejected_reason='size_exceeded', no upload.
 * AC10: Same content_hash twice in same case → second uses existing storage_path,
 *       no new upload.
 * AC11: Second attachment times out within budget → first has storage_path, second
 *       has rejected_reason='rehost_timeout', webhook still returns 202.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";

// ── Top-level mocks (hoisted before any import) ───────────────────────────────

vi.mock("@/server/email/verify-postmark-signature", () => ({
  verifyPostmarkSignature: vi.fn().mockReturnValue({ valid: true }),
}));

vi.mock("@/server/email/dedupe", () => ({
  dedupe: vi.fn().mockResolvedValue({ isDuplicate: false, existingCaseId: null }),
  normalizeMessageId: (s: string) =>
    s.trim().replace(/^<+/, "").replace(/>+$/, "").trim(),
}));

vi.mock("@/server/email/thread-lookup", () => ({
  threadLookup: vi.fn().mockResolvedValue({ existingCaseId: null }),
}));

vi.mock("@/server/worker/extract", () => ({
  runExtractionWorker: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit/index", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
  RATE_LIMIT_CONFIGS: { EMAIL_INTAKE_WEBHOOK: { limit: 100, windowMs: 10_000 } },
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

// Audit log capture.
const auditLogCalls: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockImplementation((entry: any) => {
    auditLogCalls.push({ event_type: entry.event_type, payload: entry.payload ?? {} });
    return Promise.resolve();
  }),
  AuditEvent: {
    EMAIL_RECEIVED: "email.received",
    WEBHOOK_REJECTED: "email.webhook_rejected",
    ATTACHMENT_REHOSTED: "attachment.rehosted",
    ATTACHMENT_REJECTED: "attachment.rejected",
  },
}));

// Storage bucket mock — controls upload behaviour per test.
const mockUploadAttachment = vi.fn();
vi.mock("@/server/storage/claim-attachments-bucket", () => ({
  uploadAttachment: (...args: any[]) => mockUploadAttachment(...args),
  computeContentHash: (data: Buffer) =>
    createHash("sha256").update(data).digest("hex"),
  createStorageClient: vi.fn(),
}));

// ── Shared constants ──────────────────────────────────────────────────────────

const DEFAULT_CASE_ID = "case-rehost-001";
const DEFAULT_TENANT_ID = "tenant-rehost-001";
const DEFAULT_MSG_ID = "msg-rehost-001";
const CLAIM_MSG_ID = "claim-msg-001";

// ── Supabase mock factory ─────────────────────────────────────────────────────

interface MockDb {
  attachmentInserts: Array<Record<string, unknown>>;
  existingAttachment: { storage_path: string } | null;
}

/**
 * Build a mock Supabase service client that records claim_attachments inserts
 * and optionally simulates an existing row for dedupe queries.
 */
function buildSupabaseMock(db: MockDb) {
  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "cases") {
      return {
        insert: () => ({
          select: () => ({
            single: () =>
              Promise.resolve({ data: { id: DEFAULT_CASE_ID }, error: null }),
          }),
        }),
      };
    }

    if (table === "claim_messages") {
      return {
        insert: () => ({
          select: () => ({
            single: () =>
              Promise.resolve({ data: { id: CLAIM_MSG_ID }, error: null }),
          }),
        }),
      };
    }

    if (table === "raw_messages") {
      return { insert: () => Promise.resolve({ error: null }) };
    }

    if (table === "claim_attachments") {
      return {
        // Dedupe query: SELECT storage_path WHERE case_id = ? AND content_hash = ?
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: db.existingAttachment ?? null,
                    error: null,
                  }),
              }),
            }),
          }),
        }),
        // Individual insert per attachment (W6).
        insert: (row: any) => {
          db.attachmentInserts.push(row);
          return Promise.resolve({ error: null });
        },
      };
    }

    return { insert: () => Promise.resolve({ error: null }) };
  });

  return { from };
}

// ── createServiceClient injection via top-level mock ─────────────────────────

// We mock the service module at the top level so vi.mocked() works.
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));

// ── Request builder ───────────────────────────────────────────────────────────

function buildRequest(
  attachments: Array<{
    Name: string;
    Content: string;
    ContentType: string;
    ContentLength: number;
  }>
) {
  const body = JSON.stringify({
    MessageID: DEFAULT_MSG_ID,
    From: "claimant@example.com",
    FromFull: { Email: "claimant@example.com", Name: "Test", MailboxHash: "" },
    ToFull: [{ Email: "claims@example.com", Name: "", MailboxHash: "" }],
    CcFull: [],
    BccFull: [],
    Subject: "Test claim",
    TextBody: "Test body",
    HtmlBody: "",
    StrippedTextReply: "",
    InReplyTo: "",
    References: "",
    OriginalRecipient: "claims@example.com",
    To: "claims@example.com",
    Date: new Date().toISOString(),
    Tag: "",
    MailboxHash: "",
    Headers: [{ Name: "X-Spam-Score", Value: "0" }],
    Attachments: attachments,
  });

  return new Request("http://localhost/api/intake/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-postmark-signature": "valid-sig",
    },
    body,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("attachment rehost integration", () => {
  let db: MockDb;

  beforeEach(async () => {
    vi.clearAllMocks();
    auditLogCalls.length = 0;

    db = { attachmentInserts: [], existingAttachment: null };

    process.env.DEFAULT_TENANT_ID = DEFAULT_TENANT_ID;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

    // Wire the supabase mock fresh each test.
    const { createServiceClient } = await import("@/lib/supabase/service");
    vi.mocked(createServiceClient).mockImplementation(() => buildSupabaseMock(db) as any);
  });

  afterEach(() => {
    delete process.env.DEFAULT_TENANT_ID;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  // ── AC7 ──────────────────────────────────────────────────────────────────────

  it("AC7: valid PDF → claim_attachments row with content_hash, storage_path, ATTACHMENT_REHOSTED audit", async () => {
    const raw = Buffer.from("PDF content bytes");
    const expectedHash = createHash("sha256").update(raw).digest("hex");
    const expectedPath = `${DEFAULT_TENANT_ID}/${DEFAULT_CASE_ID}/${CLAIM_MSG_ID}/abcdef-policy.pdf`;

    mockUploadAttachment.mockResolvedValue({ storagePath: expectedPath });

    const { POST } = await import("@/app/api/intake/email/route");
    const req = buildRequest([
      {
        Name: "policy.pdf",
        Content: raw.toString("base64"),
        ContentType: "application/pdf",
        ContentLength: raw.length,
      },
    ]);

    const response = await POST(req as any);
    expect(response.status).toBe(202);

    // claim_attachments row should have content_hash + storage_path.
    expect(db.attachmentInserts).toHaveLength(1);
    const row = db.attachmentInserts[0];
    expect(row.content_hash).toBe(expectedHash);
    expect(row.storage_path).toBe(expectedPath);
    expect(row.rejected_reason).toBeNull();
    expect(row.original_filename).toBe("policy.pdf");

    // ATTACHMENT_REHOSTED audit event.
    const rehostedEvent = auditLogCalls.find((e) => e.event_type === "attachment.rehosted");
    expect(rehostedEvent).toBeDefined();
    expect(rehostedEvent?.payload.content_hash_prefix).toBe(expectedHash.slice(0, 12));
    expect(rehostedEvent?.payload.storage_path).toBe(expectedPath);
  });

  // ── AC8 ──────────────────────────────────────────────────────────────────────

  it("AC8: application/x-msdownload → rejected_reason='content_type_not_allowed', no upload, ATTACHMENT_REJECTED audit", async () => {
    mockUploadAttachment.mockResolvedValue({ storagePath: "should-not-be-called" });

    const { POST } = await import("@/app/api/intake/email/route");
    const req = buildRequest([
      {
        Name: "evil.exe",
        Content: Buffer.from("MZ payload").toString("base64"),
        ContentType: "application/x-msdownload",
        ContentLength: 10,
      },
    ]);

    const response = await POST(req as any);
    expect(response.status).toBe(202);

    expect(mockUploadAttachment).not.toHaveBeenCalled();

    expect(db.attachmentInserts).toHaveLength(1);
    const row = db.attachmentInserts[0];
    expect(row.rejected_reason).toBe("content_type_not_allowed");
    expect(row.storage_path).toBeNull();

    const rejectedEvent = auditLogCalls.find((e) => e.event_type === "attachment.rejected");
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent?.payload.reason).toBe("content_type_not_allowed");
  });

  // ── AC9 ──────────────────────────────────────────────────────────────────────

  it("AC9: 11 MB attachment → rejected_reason='size_exceeded', no upload", async () => {
    const bigBuffer = Buffer.alloc(11 * 1024 * 1024 + 1, 0x42);

    const { POST } = await import("@/app/api/intake/email/route");
    const req = buildRequest([
      {
        Name: "huge.pdf",
        Content: bigBuffer.toString("base64"),
        ContentType: "application/pdf",
        ContentLength: bigBuffer.length,
      },
    ]);

    const response = await POST(req as any);
    expect(response.status).toBe(202);

    expect(mockUploadAttachment).not.toHaveBeenCalled();

    expect(db.attachmentInserts).toHaveLength(1);
    const row = db.attachmentInserts[0];
    expect(row.rejected_reason).toBe("size_exceeded");
    expect(row.storage_path).toBeNull();
  });

  // ── AC10 ─────────────────────────────────────────────────────────────────────

  it("AC10: same content_hash → second uses existing storage_path, no new upload", async () => {
    const raw = Buffer.from("duplicate-content");
    const existingPath = `${DEFAULT_TENANT_ID}/${DEFAULT_CASE_ID}/old-msg/xyz-duplicate.pdf`;

    db.existingAttachment = { storage_path: existingPath };

    const { POST } = await import("@/app/api/intake/email/route");
    const req = buildRequest([
      {
        Name: "duplicate.pdf",
        Content: raw.toString("base64"),
        ContentType: "application/pdf",
        ContentLength: raw.length,
      },
    ]);

    const response = await POST(req as any);
    expect(response.status).toBe(202);

    expect(mockUploadAttachment).not.toHaveBeenCalled();

    expect(db.attachmentInserts).toHaveLength(1);
    const row = db.attachmentInserts[0];
    expect(row.storage_path).toBe(existingPath);
    expect(row.rejected_reason).toBeNull();
  });

  // ── AC11 ─────────────────────────────────────────────────────────────────────

  it("AC11: budget exhausted → webhook still 202, timed-out attachments get rejected_reason='rehost_timeout'", async () => {
    // Use two attachments with a very short budget (1 ms) so at least the second times out.
    // We mock rehostAttachments directly to simulate budget enforcement without real timers.
    const raw1 = Buffer.from("first attachment");
    const raw2 = Buffer.from("second attachment");

    // First upload resolves immediately; second never resolves within budget.
    let uploadCallCount = 0;
    mockUploadAttachment.mockImplementation(() => {
      uploadCallCount++;
      if (uploadCallCount === 1) {
        return Promise.resolve({
          storagePath: `${DEFAULT_TENANT_ID}/${DEFAULT_CASE_ID}/${CLAIM_MSG_ID}/aaa-first.pdf`,
        });
      }
      // This promise resolves after 30 s — well past any 1 ms budget.
      return new Promise((resolve) =>
        setTimeout(() => resolve({ storagePath: "too-late" }), 30_000)
      );
    });

    // Override rehostAttachments to use budgetMs=1 so the second attachment times out.
    vi.mock("@/server/email/rehost-attachments", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("@/server/email/rehost-attachments")>();
      return {
        ...actual,
        rehostAttachments: (opts: any) =>
          actual.rehostAttachments({ ...opts, budgetMs: 1 }),
      };
    });

    const { POST } = await import("@/app/api/intake/email/route");
    const req = buildRequest([
      {
        Name: "first.pdf",
        Content: raw1.toString("base64"),
        ContentType: "application/pdf",
        ContentLength: raw1.length,
      },
      {
        Name: "second.pdf",
        Content: raw2.toString("base64"),
        ContentType: "application/pdf",
        ContentLength: raw2.length,
      },
    ]);

    const response = await POST(req as any);

    // Webhook must return 202 regardless (IC6).
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.deduped).toBe(false);

    // At least one attachment should be timed out.
    const timedOut = db.attachmentInserts.filter(
      (r) => r.rejected_reason === "rehost_timeout"
    );
    expect(timedOut.length).toBeGreaterThanOrEqual(1);

    // No ATTACHMENT_REJECTED audit event for rehost_timeout (only type/size rejections get audited).
    const timeoutRejectedAudit = auditLogCalls.filter(
      (e) => e.event_type === "attachment.rejected" && e.payload.reason === "rehost_timeout"
    );
    expect(timeoutRejectedAudit).toHaveLength(0);
  });
});
