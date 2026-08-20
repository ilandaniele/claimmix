/**
 * Uploading the bytes and writing the row that points at them.
 *
 * These were two steps in two places. `rehostAttachments` moved the file into
 * the bucket; the Gmail poller wrote the `claim_attachments` row afterwards, in
 * a loop it owned. When WhatsApp media arrived it called the first half and
 * stopped — the photo of a crumpled bumper went into R2, the upload logged
 * `stored: 1`, and nothing in the database pointed at it. The analyst saw no
 * attachment, and the agent asked again for the photo it already had.
 *
 * A row is written for every attachment, including the ones that failed: a
 * rejection with a reason is what distinguishes "nobody sent it" from "it did
 * not fit", and that distinction is the only thing that stops us asking twice.
 */

const mockDbLimit = vi.fn().mockResolvedValue([]);
const mockDbSelect = vi.fn().mockReturnValue({
  from: () => ({ where: () => ({ limit: mockDbLimit }) }),
});
const mockDbInsert = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
}));

const mockUploadAttachment = vi.fn();

vi.mock("@/server/storage/claim-attachments-bucket", () => ({
  uploadAttachment: (...args: unknown[]) => mockUploadAttachment(...args),
  computeContentHash: () => "a".repeat(64),
}));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: {
    ATTACHMENT_REHOSTED: "attachment.rehosted",
    ATTACHMENT_REJECTED: "attachment.rejected",
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  rehostAndRecordAttachments,
  type EmailAttachment,
} from "@/server/email/rehost-attachments";
import { writeAuditLog } from "@/lib/audit/log";

const OPTS = { tenantId: "tenant-1", caseId: "case-1", messageId: "msg-1" };

let rows: Array<Record<string, unknown>>;

function photo(overrides: Partial<EmailAttachment> = {}): EmailAttachment {
  const raw = Buffer.from("jpeg bytes");
  return {
    Name: "image-abc.jpg",
    Content: raw.toString("base64"),
    ContentType: "image/jpeg",
    ContentLength: raw.length,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  mockDbLimit.mockResolvedValue([]);
  mockDbInsert.mockReturnValue({
    values: (v: Record<string, unknown>) => {
      rows.push(v);
      return Promise.resolve();
    },
  });
  mockUploadAttachment.mockResolvedValue({ storagePath: "tenant-1/case-1/msg-1/image-abc.jpg" });
});

describe("rehostAndRecordAttachments", () => {
  it("writes the row that points at the uploaded file", async () => {
    // The bug this file exists for: bytes in the bucket, nothing in the table.
    await rehostAndRecordAttachments({ ...OPTS, attachments: [photo()] });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      case_id: "case-1",
      tenant_id: "tenant-1",
      claim_message_id: "msg-1",
      file_name: "image-abc.jpg",
      content_type: "image/jpeg",
      storage_path: "tenant-1/case-1/msg-1/image-abc.jpg",
      rejected_reason: null,
    });
  });

  it("records a rejected file with its reason rather than dropping it", async () => {
    // Silence here reads as "the claimant never sent it", and the agent asks
    // again for something that did arrive and was refused.
    await rehostAndRecordAttachments({
      ...OPTS,
      attachments: [photo({ Name: "invite.ics", ContentType: "text/calendar" })],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      file_name: "invite.ics",
      storage_path: null,
      rejected_reason: "content_type_not_allowed",
    });
  });

  it("records the row even when the upload itself failed", async () => {
    mockUploadAttachment.mockResolvedValue({ error: "bucket unreachable" });

    await rehostAndRecordAttachments({ ...OPTS, attachments: [photo()] });

    expect(rows[0]).toMatchObject({
      storage_path: null,
      rejected_reason: "storage_upload_failed",
    });
  });

  it("leaves an audit trail for what was stored and what was refused", async () => {
    await rehostAndRecordAttachments({
      ...OPTS,
      attachments: [photo(), photo({ Name: "x.ics", ContentType: "text/calendar" })],
    });

    const events = vi.mocked(writeAuditLog).mock.calls.map((c) => c[0].event_type);
    expect(events).toEqual(["attachment.rehosted", "attachment.rejected"]);
  });

  it("still returns the per-attachment results its caller expects", async () => {
    const results = await rehostAndRecordAttachments({
      ...OPTS,
      attachments: [photo()],
    });

    expect(results).toEqual([
      {
        stored: true,
        storagePath: "tenant-1/case-1/msg-1/image-abc.jpg",
        contentHash: "a".repeat(64),
      },
    ]);
  });

  it("keeps going when one row fails to insert", async () => {
    // Two photos, the first insert throws. Losing the second as well would
    // turn one lost file into a lost claim.
    let call = 0;
    mockDbInsert.mockReturnValue({
      values: (v: Record<string, unknown>) => {
        if (++call === 1) return Promise.reject(new Error("unique violation"));
        rows.push(v);
        return Promise.resolve();
      },
    });

    await expect(
      rehostAndRecordAttachments({
        ...OPTS,
        attachments: [photo(), photo({ Name: "second.jpg" })],
      })
    ).resolves.toHaveLength(2);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ file_name: "second.jpg" });
  });
});
