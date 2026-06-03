/**
 * POST /api/intake/email — Postmark inbound webhook.
 *
 * Replaces the 501 stub. Full flow:
 *   a) Read raw body (Buffer) for HMAC — do NOT parse before verification
 *   b) HMAC-SHA256 verification against X-Postmark-Signature header (AC2)
 *   c) Parse + validate with PostmarkInboundSchema (Zod)
 *   d) Rate limit: 100/10s per IP (AC20)
 *   e) Idempotency check by (tenant_id, provider_message_id) in claim_messages (AC2)
 *   f) Thread-reply detection via In-Reply-To / References headers (AC4/AC6)
 *   g) Thread reply → insert claim_messages row + raw_messages row, re-dispatch worker
 *   h) New email → create case + insert claim_messages row + raw_messages row,
 *      dispatch extraction worker (fire-and-forget)
 *
 * W4: Dual-write — every inbound now inserts into BOTH claim_messages (new) and
 * raw_messages (legacy).  The raw_messages insert is retained until migration 0010
 * backfills and the legacy tables are confirmed equivalent and dropped.
 *
 * Auth: No session auth — this is a server-to-server Postmark webhook.
 *       Authentication is via HMAC signature only.
 *
 * IMPORTANT: The route reads the raw body via request.text() before any JSON
 * parsing so the Buffer used for HMAC is the unmodified wire bytes.
 */

import { type NextRequest } from "next/server";
import {
  PostmarkInboundSchema,
  extractEmailBody,
  extractThreadId,
} from "@/lib/schemas/postmark-inbound";
import { verifyPostmarkSignature } from "@/server/email/verify-postmark-signature";
import { dedupe, normalizeMessageId } from "@/server/email/dedupe";
import { threadLookup } from "@/server/email/thread-lookup";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { createServiceClient } from "@/lib/supabase/service";
import {
  checkRateLimit,
  RATE_LIMIT_CONFIGS,
  getClientIp,
} from "@/lib/rate-limit/index";

/**
 * Resolve the tenant_id for the webhook.
 *
 * For MVP: Postmark sends to a single inbound address per tenant.
 * We derive the tenant from the OriginalRecipient (the inbound inbox address)
 * or from a lookup on the MailboxHash field (configured in Postmark UI).
 *
 * If neither is available, fall back to the DEFAULT_TENANT_ID env var
 * (required for single-tenant / development deployments).
 *
 * In a multi-tenant future: look up the tenant by the inbound email address.
 */
async function resolveTenantId(
  originalRecipient: string,
  mailboxHash: string
): Promise<string | null> {
  // For now: use the DEFAULT_TENANT_ID env var if set (single-tenant MVP).
  const defaultTenantId = process.env.DEFAULT_TENANT_ID;
  if (defaultTenantId) return defaultTenantId;

  // Future: query a tenant_inbound_addresses table by originalRecipient.
  // For now, if not configured, we cannot process the webhook.
  void originalRecipient; // suppress unused warning
  void mailboxHash;       // suppress unused warning
  return null;
}

/**
 * Dispatch the extraction worker for a given case.
 * Fire-and-forget — we don't await the result before returning 202.
 *
 * Uses waitUntil when available (Vercel) or runs inline async (local dev).
 * Falls back to a fire-and-forget fetch to /api/worker/extract if needed.
 */
function dispatchExtractionWorker(caseId: string, tenantId: string): void {
  // Dynamic import to avoid circular dependency with the worker module.
  const workerPromise = import("@/server/worker/extract")
    .then(({ runExtractionWorker }) => runExtractionWorker(caseId, tenantId, null))
    .catch((err: unknown) => {
      const name = err instanceof Error ? err.name : "UnknownError";
      console.error("[intake/email] Worker dispatch error:", name, "case:", caseId);
    });

  // Use waitUntil on Vercel if available.
  const context = (globalThis as any)[Symbol.for("__vercel_runtime__")] as
    | { waitUntil?: (p: Promise<unknown>) => void }
    | undefined;

  if (context?.waitUntil) {
    context.waitUntil(workerPromise);
  }
  // Local dev: fire-and-forget (Promise runs independently after response is sent).
}

/**
 * Insert a claim_messages row for an inbound email.
 *
 * Returns the inserted row id, or null if the insert failed (non-fatal during
 * the dual-write window — raw_messages is the source of truth until 0010).
 */
async function insertClaimMessage(
  supabase: ReturnType<typeof createServiceClient>,
  opts: {
    caseId: string;
    tenantId: string;
    providerMessageId: string;
    threadId: string | null;
    inReplyTo: string | null;
    fromAddr: string;
    toAddr: string;
    subject: string;
    bodyText: string;
    bodyHtml: string;
    headers: Array<{ Name: string; Value: string }>;
    rawPayload: unknown;
  }
): Promise<string | null> {
  const {
    caseId,
    tenantId,
    providerMessageId,
    threadId,
    inReplyTo,
    fromAddr,
    toAddr,
    subject,
    bodyText,
    bodyHtml,
    headers,
    rawPayload,
  } = opts;

  const { data, error } = await (supabase as any)
    .from("claim_messages")
    .insert({
      case_id: caseId,
      tenant_id: tenantId,
      direction: "inbound",
      provider: "postmark",
      provider_message_id: providerMessageId,
      thread_id: threadId,
      in_reply_to: inReplyTo,
      from_addr: fromAddr,
      to_addr: toAddr,
      subject,
      body_text: bodyText,
      body_html: bodyHtml,
      headers,        // jsonb — full Postmark Headers array
      raw_payload: rawPayload,  // jsonb — verbatim parsed webhook JSON
      status: "received",
      received_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    // Log error code only — body may contain PII.
    console.error("[intake/email] claim_messages insert error:", error.code);
    return null;
  }

  return (data as { id: string }).id;
}

export async function POST(request: NextRequest): Promise<Response> {
  const ip = getClientIp(request);

  // ── a) Read raw body as text first, then convert to Buffer for HMAC ─────────
  // Do NOT call request.json() before this — it would consume the body stream.
  let rawBodyText: string;
  try {
    rawBodyText = await request.text();
  } catch {
    return new Response(
      JSON.stringify({ error: { code: "INVALID_PAYLOAD", message: "No se pudo leer el cuerpo de la solicitud." } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const rawBodyBuffer = Buffer.from(rawBodyText, "utf-8");
  const signatureHeader = request.headers.get("x-postmark-signature");

  // ── b) HMAC verification ─────────────────────────────────────────────────────
  let signatureValid = false;
  try {
    const result = verifyPostmarkSignature(rawBodyBuffer, signatureHeader);
    signatureValid = result.valid;
  } catch (configErr) {
    // POSTMARK_WEBHOOK_SECRET not set — configuration error, fail with 500.
    const name = configErr instanceof Error ? configErr.name : "ConfigError";
    console.error("[intake/email] Signature config error:", name);
    return new Response(
      JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Error de configuración del servidor." } }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!signatureValid) {
    // Write audit log for rejected webhook — use a fallback tenant_id.
    // Note: we don't have the tenant yet at this point, so we use a sentinel value.
    // The audit log record is still useful for security monitoring.
    const fallbackTenantId = process.env.DEFAULT_TENANT_ID ?? "00000000-0000-0000-0000-000000000000";
    await writeAuditLog({
      tenant_id: fallbackTenantId,
      actor_id: null,
      event_type: AuditEvent.WEBHOOK_REJECTED,
      target_type: null,
      target_id: null,
      payload: { reason: "invalid_signature" },
      ip,
    });

    return new Response(
      JSON.stringify({ error: { code: "INVALID_WEBHOOK_SIGNATURE", message: "Firma del webhook inválida o ausente." } }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── c) Parse and validate payload with Zod ──────────────────────────────────
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawBodyText);
  } catch {
    return new Response(
      JSON.stringify({ error: { code: "INVALID_PAYLOAD", message: "El cuerpo de la solicitud no es JSON válido." } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const parsed = PostmarkInboundSchema.safeParse(rawJson);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_PAYLOAD",
          message: "El payload de Postmark no tiene el formato esperado.",
          details: parsed.error.flatten(),
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const payload = parsed.data;

  // ── d) Rate limit ─────────────────────────────────────────────────────────────
  const { limit, windowMs } = RATE_LIMIT_CONFIGS.EMAIL_INTAKE_WEBHOOK;
  const rl = checkRateLimit(`email-intake:${ip}`, limit, windowMs);

  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: { code: "RATE_LIMITED", message: "Demasiadas solicitudes. Esperá un momento." } }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(rl.retryAfter ?? 10),
        },
      }
    );
  }

  // ── e) Resolve tenant ─────────────────────────────────────────────────────────
  const tenantId = await resolveTenantId(
    payload.OriginalRecipient,
    payload.MailboxHash
  );

  if (!tenantId) {
    console.error("[intake/email] Could not resolve tenant — DEFAULT_TENANT_ID not set");
    return new Response(
      JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "No se pudo determinar el tenant para este webhook." } }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // AC15: Normalize the provider_message_id — strip angle brackets at the boundary.
  // Postmark's MessageID field does NOT include angle brackets, but we normalise
  // defensively here so storage is always angle-bracket-free.
  const providerMessageId = normalizeMessageId(payload.MessageID);

  const fromEmail = payload.FromFull.Email;
  const subject = payload.Subject;
  const body = extractEmailBody(payload);

  // In-Reply-To normalisation: strip angle brackets before storage and comparison.
  const inReplyToRaw = payload.InReplyTo || "";
  const inReplyTo = inReplyToRaw ? normalizeMessageId(inReplyToRaw) : null;

  // thread_id: follows cases.email_thread_id semantics (first message in chain).
  // For a new email this is the MessageID itself; for a reply it resolves to the
  // thread root via extractThreadId() which also strips angle brackets.
  const threadId = extractThreadId(payload) ?? providerMessageId;

  // to_addr: the intake inbox address.
  const toAddr =
    payload.OriginalRecipient ||
    payload.ToFull[0]?.Email ||
    "";

  // ── f) Idempotency check against claim_messages ───────────────────────────────
  const { isDuplicate, existingCaseId: dedupedCaseId } = await dedupe(
    providerMessageId,
    tenantId
  );

  if (isDuplicate && dedupedCaseId) {
    return new Response(
      JSON.stringify({ caseId: dedupedCaseId, deduped: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── g) Thread-reply detection ─────────────────────────────────────────────────
  const { existingCaseId: threadCaseId } = await threadLookup(
    tenantId,
    payload.InReplyTo,
    payload.References
  );

  const supabase = createServiceClient();

  // ── h) Thread reply: insert claim_messages + raw_messages, re-dispatch worker ─
  if (threadCaseId) {
    // W4: Insert claim_messages row (new — dual-write).
    await insertClaimMessage(supabase, {
      caseId: threadCaseId,
      tenantId,
      providerMessageId,
      threadId,
      inReplyTo,
      fromAddr: fromEmail,
      toAddr,
      subject,
      bodyText: body,
      bodyHtml: payload.HtmlBody,
      headers: payload.Headers,
      rawPayload: rawJson,
    });

    // Insert a new raw_messages row linked to the existing case (dual-write — keep legacy).
    const { error: rawMsgError } = await (supabase as any).from("raw_messages").insert({
      case_id: threadCaseId,
      tenant_id: tenantId,
      channel: "email",
      from_addr: fromEmail,
      subject,
      body,
    });

    if (rawMsgError) {
      console.error("[intake/email] raw_messages insert (thread):", rawMsgError.code);
    }

    // Audit log for thread reply.
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.EMAIL_RECEIVED,
      target_type: "case",
      target_id: threadCaseId,
      payload: { action: "thread_update", message_id: providerMessageId },
    });

    // Re-dispatch extraction worker in memory-aware mode.
    dispatchExtractionWorker(threadCaseId, tenantId);

    return new Response(
      JSON.stringify({ caseId: threadCaseId, deduped: false }),
      { status: 202, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── i) New email: create case + claim_messages + raw_messages, dispatch worker ─
  const { data: newCase, error: caseError } = await (supabase as any)
    .from("cases")
    .insert({
      tenant_id: tenantId,
      channel: "email",
      status: "recibido",
      email_message_id: providerMessageId,
      email_thread_id: providerMessageId, // first message in thread = its own thread ID
      is_claim: true, // optimistic — worker may set to false after extraction
      claim_type: "choque", // default — worker will update after extraction
    })
    .select("id")
    .single();

  if (caseError || !newCase) {
    console.error("[intake/email] Failed to create case:", caseError?.code);
    return new Response(
      JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Error al crear el caso." } }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const newCaseId = (newCase as { id: string }).id;

  // W4: Insert claim_messages row (new — dual-write).
  await insertClaimMessage(supabase, {
    caseId: newCaseId,
    tenantId,
    providerMessageId,
    threadId,
    inReplyTo,
    fromAddr: fromEmail,
    toAddr,
    subject,
    bodyText: body,
    bodyHtml: payload.HtmlBody,
    headers: payload.Headers,
    rawPayload: rawJson,
  });

  // Insert raw_messages row (dual-write — keep legacy table during transition).
  // email_message_id / email_thread_id are stored on the cases table.
  // raw_messages stores the body and sender metadata only.
  const { error: rawMsgError } = await (supabase as any).from("raw_messages").insert({
    case_id: newCaseId,
    tenant_id: tenantId,
    channel: "email",
    from_addr: fromEmail,
    subject,
    body,
  });

  if (rawMsgError) {
    console.error("[intake/email] raw_messages insert (new):", rawMsgError.code);
    // Non-fatal — case created; worker will still run and may re-read the payload.
  }

  // AC23: Insert claim_attachments rows for each attachment in the payload.
  // Attachment URLs are NOT logged to stdout (PII protection — AC23).
  const attachments = payload.Attachments ?? [];
  if (attachments.length > 0) {
    const attachmentInserts = attachments.map((a) => ({
      case_id: newCaseId,
      tenant_id: tenantId,
      file_name: a.Name,
      content_type: a.ContentType,
      size_bytes: a.ContentLength,
      // ContentURL is Postmark's CDN link; ContentID is for inline attachments.
      // Use ContentURL as the external URL when present; fall back to null.
      external_url: a.ContentURL || null,
      source_message_id: providerMessageId,
    }));

    const { error: attachmentsError } = await (supabase as any)
      .from("claim_attachments")
      .insert(attachmentInserts);

    if (attachmentsError) {
      console.error("[intake/email] claim_attachments insert:", attachmentsError.code);
      // Non-fatal — case and raw_message are already persisted; attachments
      // may be retried by re-sending the email. Log the error code only (no URL).
    }
  }

  // Audit log.
  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: null,
    event_type: AuditEvent.EMAIL_RECEIVED,
    target_type: "case",
    target_id: newCaseId,
    payload: { action: "new_case", message_id: providerMessageId },
    ip,
  });

  // Dispatch extraction worker asynchronously (fire-and-forget).
  dispatchExtractionWorker(newCaseId, tenantId);

  return new Response(
    JSON.stringify({ caseId: newCaseId, deduped: false }),
    { status: 202, headers: { "Content-Type": "application/json" } }
  );
}
