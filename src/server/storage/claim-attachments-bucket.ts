/**
 * Supabase Storage client for the `claim-attachments` bucket.
 *
 * Uses the service-role key so uploads bypass RLS (uploads are system-actor
 * operations, not user-actor). Service-role key is NEVER exposed to the client.
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
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { sanitizeFilename } from "@/server/email/attachment-validator";

const BUCKET = "claim-attachments";

// ── Storage client factory ───────────────────────────────────────────────────

/**
 * Create a Supabase client with the service-role key.
 *
 * Called once per request — not a module-level singleton, so env-var overrides
 * in tests work correctly between test cases.
 */
export function createStorageClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "[claim-attachments-bucket] NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."
    );
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
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
 * Upload a single attachment Buffer to Supabase Storage.
 *
 * The storage path is deterministic given the same messageId + sanitized filename,
 * but the 8-byte hex prefix in sanitizeFilename() guarantees uniqueness even when
 * the same filename is sent twice in different messages.
 *
 * upsert: false — duplicate uploads within the same message will fail fast with
 * a storage error, which the caller converts to { stored: false, reason: 'storage_upload_failed' }.
 * Deduplication by content_hash (AC10) prevents reaching this path for true duplicates.
 */
export async function uploadAttachment(
  opts: UploadAttachmentOpts
): Promise<UploadAttachmentResult> {
  const { tenantId, caseId, messageId, filename, contentType, data } = opts;

  const sanitizedName = sanitizeFilename(filename);
  const storagePath = `${tenantId}/${caseId}/${messageId}/${sanitizedName}`;

  const supabase = createStorageClient();

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, data, {
      contentType,
      upsert: false,
    });

  if (error) {
    // Log storage error code only — path may contain tenant/case IDs but not PII.
    console.error("[claim-attachments-bucket] Upload failed:", (error as any).statusCode ?? "unknown"); // crew-debug-ok
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
