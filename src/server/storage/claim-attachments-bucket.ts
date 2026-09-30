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
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import { sanitizeFilename } from "@/server/email/attachment-validator";
import { logger } from "@/lib/observability/logger";

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

/** Writes a new object; a key that already exists fails with 412. */
async function put(key: string, contentType: string, data: Buffer): Promise<void> {
  await createStorageClient().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: data,
      ContentType: contentType,
      // Fail when the key already exists (replicates Neon upsert: false).
      IfNoneMatch: "*",
    })
  );
}

const statusDe = (error: unknown) =>
  (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? "unknown";

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
 * PreconditionFailed (equivalent of Neon upsert: false), which the caller
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
    await put(storagePath, contentType, data);
  } catch (error) {
    // Log status code only — path may contain tenant/case IDs but not PII.
    // 412 PreconditionFailed = key already exists (duplicate upload).
    logger.error({ status_code: statusDe(error) }, "claim_attachments_bucket.upload_failed");
    return { error: "STORAGE_UPLOAD_FAILED" };
  }

  return { storagePath };
}

/**
 * Guarda el PDF de condiciones de una póliza, con el hash como nombre.
 *
 * El mismo archivo subido dos veces cae en la misma clave: el 412 dice que ya
 * está, y eso es éxito. Devuelve la ruta, o null si no se pudo guardar.
 */
export async function subirCondiciones(tenantId: string, policyId: string, data: Buffer): Promise<string | null> {
  const ruta = `${tenantId}/policies/${policyId}/${computeContentHash(data)}.pdf`;
  try {
    await put(ruta, "application/pdf", data);
  } catch (error) {
    const status = statusDe(error);
    if (status === 412) return ruta;
    logger.error({ status_code: status }, "claim_attachments_bucket.upload_failed");
    return null;
  }
  return ruta;
}

/**
 * Compute a SHA-256 hex digest of a Buffer.
 *
 * Used for content-hash deduplication (AC10) and audit log prefix.
 */
export function computeContentHash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Read an attachment back out of the bucket.
 *
 * Used to show a photo to the model when deciding which requested document it
 * is. Returns null rather than throwing: not being able to look at the file
 * means the document stays on the outstanding list, which is the safe
 * direction — marking one received in error hides it from the analyst.
 */
export async function readAttachment(storagePath: string): Promise<Buffer | null> {
  try {
    const s3 = createStorageClient();
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucketName(), Key: storagePath })
    );
    const bytes = await res.Body?.transformToByteArray();
    return bytes ? Buffer.from(bytes) : null;
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    logger.error({ error_name: name }, "attachments.read_failed");
    return null;
  }
}

/**
 * Abre un adjunto para servirlo tal cual, en streaming.
 *
 * `readAttachment` junta todo en un Buffer, y eso es lo que no sirve acá: una
 * función de Vercel corta la respuesta en 4.5 MB y un adjunto llega a pesar
 * 10 MB. Devuelve `null` en error, mismo criterio que `readAttachment`: la
 * ruta que llama a esto lo convierte en un 404 y no filtra la causa.
 */
export async function abrirAdjunto(
  storagePath: string
): Promise<{ cuerpo: ReadableStream<Uint8Array>; largo: number | undefined } | null> {
  try {
    const s3 = createStorageClient();
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucketName(), Key: storagePath })
    );
    const cuerpo = res.Body?.transformToWebStream();
    if (!cuerpo) return null;
    return { cuerpo, largo: res.ContentLength };
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    logger.error({ error_name: name }, "attachments.open_failed");
    return null;
  }
}

/**
 * Remove an object from the bucket.
 *
 * Deliberately not reachable from anything that handles a claim: an attachment
 * belongs to a claim file and deleting one is a decision for a person with a
 * retention policy, not for code reacting to a message.
 *
 * Two callers, and only those: the health check, which proves the bucket really
 * works by writing to it — and would otherwise leave a scrap of test data behind
 * on every run — and the deferred purge (`purgar-adjuntos.ts`), which deletes
 * the objects of cases that were already deleted, after a grace period and from
 * a queue, never at the moment a person deletes a case.
 */
export async function deleteAttachment(storagePath: string): Promise<boolean> {
  try {
    const s3 = createStorageClient();
    await s3.send(new DeleteObjectCommand({ Bucket: bucketName(), Key: storagePath }));
    return true;
  } catch (err) {
    const name = err instanceof Error ? err.name : "UnknownError";
    logger.error({ error_name: name }, "attachments.delete_failed");
    return false;
  }
}
