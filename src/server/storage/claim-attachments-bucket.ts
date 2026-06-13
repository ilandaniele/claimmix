/**
 * Cloudflare R2 (S3-compatible) client for the `claim-attachments` bucket.
 *
 * Uses server-only R2 credentials so uploads are system-actor operations.
 * Credentials are NEVER exposed to the client.
 *
 * Storage path convention (IC2):
 *   {tenant_id}/{case_id}/{message_id}/{random8hex}-{sanitized_filename}
 *
 * The bucket is private; signed URLs (TTL 1h) are used for read access.
 * This module handles write only; read URL generation is out of scope for W6.
 *
 * AC7: Attachments uploaded with content_hash in claim_attachments row.
 */

import "server-only";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import { sanitizeFilename } from "@/server/email/attachment-validator";

/** Bucket name — resolved at call time so env-var overrides in tests work. */
function bucketName(): string {
  return process.env.R2_BUCKET || "claim-attachments";
}

// ── Storage client factory ───────────────────────────────────────────────────

let client: S3Client | null = null;

/**
 * Return the R2 (S3-compatible) client.
 *
 * Lazy-init singleton: the client is created (and env vars validated) on first
 * use, NOT at import time — so CI builds without R2 credentials still pass.
 */
export function createStorageClient(): S3Client {
  if (client) return client;

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "[claim-attachments-bucket] R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set."
    );
  }

  client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  return client;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface UploadAttachmentOpts {
  tenantId: string;
  caseId: string;
  messageId: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export type UploadAttachmentResult =
  | { storagePath: string }
  | { error: string };

/**
 * Upload a single attachment Buffer to Cloudflare R2.
 *
 * The storage path is deterministic given the same messageId + sanitized filename,
 * but the 8-byte hex prefix in sanitizeFilename() guarantees uniqueness even when
 * the same filename is sent twice in different messages.
 *
 * IfNoneMatch: "*" — duplicate uploads to the same key fail fast with a 412
 * PreconditionFailed (equivalent of Supabase upsert: false), which the caller
 * converts to { stored: false, reason: 'storage_upload_failed' }.
 * Deduplication by content_hash (AC10) prevents reaching this path for true duplicates.
 */
export async function uploadAttachment(
  opts: UploadAttachmentOpts
): Promise<UploadAttachmentResult> {
  const { tenantId, caseId, messageId, filename, contentType, data } = opts;

  const sanitizedName = sanitizeFilename(filename);
  const storagePath = `${tenantId}/${caseId}/${messageId}/${sanitizedName}`;

  try {
    const s3 = createStorageClient();
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName(),
        Key: storagePath,
        Body: data,
        ContentType: contentType,
        // Fail when the key already exists (replicates Supabase upsert: false).
        IfNoneMatch: "*",
      })
    );
  } catch (error) {
    // Log status code only — path may contain tenant/case IDs but not PII.
    // 412 PreconditionFailed = key already exists (duplicate upload).
    const statusCode =
      (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode ?? "unknown";
    console.error("[claim-attachments-bucket] Upload failed:", statusCode); // crew-debug-ok
    return { error: "STORAGE_UPLOAD_FAILED" };
  }

  return { storagePath };
}

/**
 * Compute a SHA-256 hex digest of a Buffer.
 *
 * Used for content-hash deduplication (AC10) and audit log prefix.
 */
export function computeContentHash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
