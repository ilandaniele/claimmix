/**
 * Unit tests for src/server/email/rehost-attachments.ts
 *
 * Uses vi.mock to replace the Supabase client and uploadAttachment so no
 * real network calls are made.
 *
 * AC7:  Valid attachment → returns { stored: true, storagePath, contentHash }
 * AC8:  Disallowed content-type → { stored: false, reason: 'content_type_not_allowed' }
 * AC9:  Oversize → { stored: false, reason: 'size_exceeded' }
 * AC10: Same content_hash within a case → reuse existing path, no upload
 * AC11: Budget exhausted → { stored: false, reason: 'rehost_timeout' }
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

// ── Mock the storage bucket module ────────────────────────────────────────────

const mockUploadAttachment = vi.fn();
const mockComputeContentHash = vi.fn();

vi.mock("@/server/storage/claim-attachments-bucket", () => ({
  uploadAttachment: (...args: any[]) => mockUploadAttachment(...args),
  computeContentHash: (...args: any[]) => mockComputeContentHash(...args),
}));

// ── Import SUT after mocks are registered ─────────────────────────────────────

import { rehostAttachments, type EmailAttachment } from "@/server/email/rehost-attachments";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a Supabase mock that returns no existing attachment by default. */
function buildSupabaseMock(existingStoragePath: string | null = null) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: existingStoragePath ? { storage_path: existingStoragePath } : null,
    error: null,
  });
  const limit = vi.fn().mockReturnValue({ maybeSingle });
  const eq2 = vi.fn().mockReturnValue({ limit });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
  const select = vi.fn().mockReturnValue({ eq: eq1 });
  const from = vi.fn().mockReturnValue({ select });

  return { from } as any;
}

/** Build a valid PDF attachment. */
function buildPdfAttachment(overrides: Partial<EmailAttachment> = {}): EmailAttachment {
  const content = Buffer.from("PDF bytes here").toString("base64");
  return {
    Name: "policy.pdf",
    Content: content,
    ContentType: "application/pdf",
    ContentLength: Buffer.from(content, "base64").length,
    ...overrides,
  };
}

/** Build a PDF attachment whose decoded buffer has a known SHA-256. */
function buildAttachmentWithKnownHash(): { attachment: EmailAttachment; hash: string } {
  const raw = Buffer.from("known-content-for-hashing-12345");
  const hash = createHash("sha256").update(raw).digest("hex");
  const attachment: EmailAttachment = {
    Name: "known.pdf",
    Content: raw.toString("base64"),
    ContentType: "application/pdf",
    ContentLength: raw.length,
  };
  return { attachment, hash };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("rehostAttachments", () => {
  const BASE_OPTS = {
    tenantId: "tenant-1",
    caseId: "case-1",
    messageId: "msg-1",
    budgetMs: 5_000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: computeContentHash calls through to real SHA-256.
    mockComputeContentHash.mockImplementation((data: Buffer) =>
      createHash("sha256").update(data).digest("hex")
    );
  });

  // ── AC7: happy path ──────────────────────────────────────────────────────────

  it("AC7: valid PDF attachment → stored:true with storagePath and contentHash", async () => {
    const attachment = buildPdfAttachment();
    const supabase = buildSupabaseMock(null); // no existing row
    mockUploadAttachment.mockResolvedValue({ storagePath: "tenant-1/case-1/msg-1/abc-policy.pdf" });

    const results = await rehostAttachments({
      ...BASE_OPTS,
      supabase,
      attachments: [attachment],
    });

    expect(results).toHaveLength(1);
    expect(results[0].stored).toBe(true);
    if (results[0].stored) {
      expect(results[0].storagePath).toBe("tenant-1/case-1/msg-1/abc-policy.pdf");
      expect(results[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(mockUploadAttachment).toHaveBeenCalledOnce();
  });

  it("AC7: uploadAttachment receives correct opts (tenantId, caseId, messageId, contentType)", async () => {
    const attachment = buildPdfAttachment();
    const supabase = buildSupabaseMock(null);
    mockUploadAttachment.mockResolvedValue({ storagePath: "p" });

    await rehostAttachments({
      ...BASE_OPTS,
      supabase,
      attachments: [attachment],
    });

    expect(mockUploadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        caseId: "case-1",
        messageId: "msg-1",
        filename: "policy.pdf",
        contentType: "application/pdf",
      })
    );
  });

  // ── AC8: content-type rejection ───────────────────────────────────────────────

  it("AC8: application/x-msdownload → stored:false, reason=content_type_not_allowed", async () => {
    const attachment: EmailAttachment = {
      Name: "evil.exe",
      Content: Buffer.from("MZ payload").toString("base64"),
      ContentType: "application/x-msdownload",
      ContentLength: 10,
    };
    const supabase = buildSupabaseMock(null);

    const results = await rehostAttachments({
      ...BASE_OPTS,
      supabase,
      attachments: [attachment],
    });

    expect(results).toHaveLength(1);
    expect(results[0].stored).toBe(false);
    if (!results[0].stored) {
      expect(results[0].reason).toBe("content_type_not_allowed");
    }
    expect(mockUploadAttachment).not.toHaveBeenCalled();
  });

  // ── AC9: size cap ─────────────────────────────────────────────────────────────

  it("AC9: 11 MB attachment → stored:false, reason=size_exceeded", async () => {
    // Create a buffer just over the 10 MB limit.
    const bigBuffer = Buffer.alloc(11 * 1024 * 1024 + 1, 0x42);
    const attachment: EmailAttachment = {
      Name: "big.pdf",
      Content: bigBuffer.toString("base64"),
      ContentType: "application/pdf",
      ContentLength: bigBuffer.length,
    };
    const supabase = buildSupabaseMock(null);

    const results = await rehostAttachments({
      ...BASE_OPTS,
      supabase,
      attachments: [attachment],
    });

    expect(results).toHaveLength(1);
    expect(results[0].stored).toBe(false);
    if (!results[0].stored) {
      expect(results[0].reason).toBe("size_exceeded");
    }
    expect(mockUploadAttachment).not.toHaveBeenCalled();
  });

  // ── AC10: content-hash deduplication ─────────────────────────────────────────

  it("AC10: existing attachment with same content_hash → reuses storagePath, no upload", async () => {
    const { attachment, hash } = buildAttachmentWithKnownHash();
    const existingPath = "tenant-1/case-1/old-msg/abcd-known.pdf";
    const supabase = buildSupabaseMock(existingPath);

    const results = await rehostAttachments({
      ...BASE_OPTS,
      supabase,
      attachments: [attachment],
    });

    expect(results).toHaveLength(1);
    expect(results[0].stored).toBe(true);
    if (results[0].stored) {
      expect(results[0].storagePath).toBe(existingPath);
      expect(results[0].contentHash).toBe(hash);
    }
    // No new upload should have been attempted.
    expect(mockUploadAttachment).not.toHaveBeenCalled();
  });

  // ── AC11: budget exhaustion ───────────────────────────────────────────────────

  it("AC11: second attachment times out when budget exhausted after first", async () => {
    const firstAttachment = buildPdfAttachment({ Name: "first.pdf" });
    const secondAttachment = buildPdfAttachment({ Name: "second.pdf" });

    // Build two separate Supabase mocks (one per attachment query).
    // The first query returns no existing row; the second won't be reached if timeout fires.
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const limit = vi.fn().mockReturnValue({ maybeSingle });
    const eq2 = vi.fn().mockReturnValue({ limit });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    const supabase = { from: vi.fn().mockReturnValue({ select }) } as any;

    // First upload succeeds immediately.
    // Second upload takes longer than the remaining budget.
    let callCount = 0;
    mockUploadAttachment.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ storagePath: "tenant-1/case-1/msg-1/abc-first.pdf" });
      }
      // Second call should never be reached if budget check fires first.
      return new Promise((resolve) =>
        setTimeout(() => resolve({ storagePath: "late.pdf" }), 10_000)
      );
    });

    // Use a very short budget so the second attachment's remaining budget is ≤ 0.
    // We simulate this by setting budgetMs=1 and using a slow dedupe query for the second.
    const results = await rehostAttachments({
      ...BASE_OPTS,
      supabase,
      attachments: [firstAttachment, secondAttachment],
      budgetMs: 1, // 1 ms — first upload should succeed, second should timeout immediately
    });

    expect(results).toHaveLength(2);
    // Second result must be a timeout regardless of upload outcome.
    expect(results[1].stored).toBe(false);
    if (!results[1].stored) {
      expect(results[1].reason).toBe("rehost_timeout");
    }
  });

  it("AC11: all attachments after budget exhaustion get rehost_timeout", async () => {
    const attachments = [
      buildPdfAttachment({ Name: "a.pdf" }),
      buildPdfAttachment({ Name: "b.pdf" }),
      buildPdfAttachment({ Name: "c.pdf" }),
    ];

    const supabase = buildSupabaseMock(null);
    mockUploadAttachment.mockResolvedValue({ storagePath: "p" });

    // budgetMs = 0 means all attachments start with remaining <= 0.
    const results = await rehostAttachments({
      ...BASE_OPTS,
      supabase,
      attachments,
      budgetMs: 0,
    });

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.stored).toBe(false);
      if (!result.stored) {
        expect(result.reason).toBe("rehost_timeout");
      }
    }
    expect(mockUploadAttachment).not.toHaveBeenCalled();
  });

  // ── Upload failure ────────────────────────────────────────────────────────────

  it("upload failure → stored:false, reason=storage_upload_failed", async () => {
    const attachment = buildPdfAttachment();
    const supabase = buildSupabaseMock(null);
    mockUploadAttachment.mockResolvedValue({ error: "STORAGE_UPLOAD_FAILED" });

    const results = await rehostAttachments({
      ...BASE_OPTS,
      supabase,
      attachments: [attachment],
    });

    expect(results).toHaveLength(1);
    expect(results[0].stored).toBe(false);
    if (!results[0].stored) {
      expect(results[0].reason).toBe("storage_upload_failed");
    }
  });

  // ── Aggregate 25 MB cap ────────────────────────────────────────────────────────

  it("rejects remaining attachments when aggregate size exceeds 25 MB", async () => {
    // Three attachments each ~9 MB (all under the 10 MB per-attachment cap).
    // Running totals: 9 MB → 18 MB → 27 MB.
    // At 27 MB the aggregate cap (25 MB) is exceeded on the third attachment.
    // Expected: first two stored:true, third stored:false reason=aggregate_size_exceeded.
    const MB = 1024 * 1024;

    const makeAttachment = (name: string, sizeBytes: number): EmailAttachment => {
      const buf = Buffer.alloc(sizeBytes, 0x41);
      return {
        Name: name,
        Content: buf.toString("base64"),
        ContentType: "application/pdf",
        ContentLength: sizeBytes,
      };
    };

    const first  = makeAttachment("chunk1.pdf", 9 * MB);  // running: 9 MB — ok
    const second = makeAttachment("chunk2.pdf", 9 * MB);  // running: 18 MB — ok
    const third  = makeAttachment("chunk3.pdf", 9 * MB);  // running: 27 MB — exceeds 25 MB cap

    const supabase = buildSupabaseMock(null);
    // Each successful upload returns a unique path.
    mockUploadAttachment
      .mockResolvedValueOnce({ storagePath: "tenant-1/case-1/msg-1/abc-chunk1.pdf" })
      .mockResolvedValueOnce({ storagePath: "tenant-1/case-1/msg-1/abc-chunk2.pdf" });

    const results = await rehostAttachments({
      ...BASE_OPTS,
      supabase,
      attachments: [first, second, third],
      budgetMs: 30_000,  // generous budget — timeout must not fire here
    });

    expect(results).toHaveLength(3);

    // First two attachments are each under 10 MB and running total ≤ 25 MB → stored
    expect(results[0].stored).toBe(true);
    expect(results[1].stored).toBe(true);

    // Third attachment: running total crosses 25 MB → rejected with aggregate reason
    expect(results[2].stored).toBe(false);
    if (!results[2].stored) {
      expect(results[2].reason).toBe("aggregate_size_exceeded");
    }

    // Upload should have been called only for the first two attachments
    expect(mockUploadAttachment).toHaveBeenCalledTimes(2);
  });

  // ── Empty attachments list ────────────────────────────────────────────────────

  it("empty attachments list → returns empty array", async () => {
    const supabase = buildSupabaseMock(null);
    const results = await rehostAttachments({
      ...BASE_OPTS,
      supabase,
      attachments: [],
    });
    expect(results).toHaveLength(0);
    expect(mockUploadAttachment).not.toHaveBeenCalled();
  });

  // ── Result ordering ────────────────────────────────────────────────────────────

  it("returns results in the same order as input attachments", async () => {
    const pdf = buildPdfAttachment({ Name: "good.pdf" });
    const exe: EmailAttachment = {
      Name: "evil.exe",
      Content: Buffer.from("bytes").toString("base64"),
      ContentType: "application/x-msdownload",
      ContentLength: 5,
    };
    const supabase = buildSupabaseMock(null);
    mockUploadAttachment.mockResolvedValue({ storagePath: "p" });

    const results = await rehostAttachments({
      ...BASE_OPTS,
      supabase,
      attachments: [pdf, exe],
    });

    expect(results).toHaveLength(2);
    expect(results[0].stored).toBe(true); // pdf → ok
    expect(results[1].stored).toBe(false); // exe → rejected
  });
});
