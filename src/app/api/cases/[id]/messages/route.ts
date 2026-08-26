/**
 * GET /api/cases/:id/messages — inbound email thread for a case.
 *
 * AC8: Returns 200 + messages array (id, direction, provider, subject,
 *      from_addr, body_text, received_at, attachment_count) for valid case.
 * AC9: Returns 404 NOT_FOUND when case belongs to a different tenant (IDOR safe).
 * AC10: Returns 200 + { messages: [] } when no claim_messages rows exist.
 * AC13: body_text is truncated to 500 chars server-side before sending to client.
 * AC14: attachment_count aggregated from claim_attachments per message.
 *
 * Security:
 * - Auth: Better Auth session; explicit tenant_id filters (RLS is gone).
 * - IDOR: case ownership verified first (404 not 403 for wrong-tenant).
 * - PII: from_addr, subject, body_text are PII — NEVER logged.
 * - Rate limit: CASES_API (100/min per user).
 */

import { type NextRequest } from "next/server";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { requireRole, ALL_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { cases, claimAttachments, claimMessages } from "@/lib/db/schema";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
} from "@/lib/rate-limit/index";
import { z } from "zod";

// ── Params schema ─────────────────────────────────────────────────────────────

const ParamsSchema = z.object({
  id: z.string().uuid("ID de caso inválido."),
});

// ── Constants ─────────────────────────────────────────────────────────────────

const BODY_TEXT_MAX_CHARS = 500;
const MESSAGES_LIMIT = 50;

/** Extract a loggable error code from a thrown DB error (PII-safe). */
function dbErrCode(e: unknown): string {
  return (
    (e as { code?: string })?.code ??
    (e instanceof Error ? e.name : "UnknownError")
  );
}

// ── GET /api/cases/:id/messages ───────────────────────────────────────────────

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  // ── 1. Auth ───────────────────────────────────────────────────────────────
  let ctx: RoleContext;
  try {
    ctx = await requireRole(...ALL_ROLES);
  } catch {
    return err(new AppError("MISSING_SESSION", "Se requiere autenticación."));
  }
  const { userRow } = ctx;
  const tenantId = userRow.tenant_id;
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    // Este contexto es lo único que le dice de quién son los datos.
    const tenantCtx: TenantContext = { tenantId: tenantId };

  // ── 2. Rate limit ─────────────────────────────────────────────────────────
  const rlKey = buildUserKey(userRow.id, "cases-messages-get");
  const rl = await rateLimit(rlKey, RATE_LIMIT_CONFIGS.CASES_API);
  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes."));
  }

  // ── 3. Validate route params — Next.js 16: params is a Promise ───────────
  const rawParams = await context.params;
  const parsedParams = ParamsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    return err(new AppError("NOT_FOUND", "El caso no existe."));
  }

  const { id: caseId } = parsedParams.data;

  // ── 4. IDOR pre-check: verify case exists AND belongs to user's tenant ────
  //    Explicit tenant_id filter — wrong-tenant case yields no row → 404.
  try {
    let caseRow: { id: string } | null;
    try {
      caseRow = firstRow(
        await enTenant(tenantCtx, (db) =>
          db
            .select({ id: cases.id })
            .from(cases)
            .where(eq(cases.id, caseId))
            .limit(1)
        )
      );
    } catch (e) {
      console.error("[GET /api/cases/:id/messages] case lookup error:", dbErrCode(e)); // crew-debug-ok
      return err(new AppError("INTERNAL_ERROR"));
    }

    if (!caseRow) {
      // Case not found OR belongs to different tenant — always 404, never 403.
      return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
    }

    // ── 5. Fetch inbound messages with attachment counts ────────────────────
    //    body_text truncated server-side to BODY_TEXT_MAX_CHARS.
    //    attachment_count aggregated from claim_attachments per message.
    let messages: Array<{
      id: string;
      direction: string;
      provider: string;
      subject: string | null;
      from_addr: string | null;
      body_text: string | null;
      received_at: string;
    }>;
    try {
      messages = await enTenant(tenantCtx, (db) =>
        db
          .select({
            id: claimMessages.id,
            direction: claimMessages.direction,
            provider: claimMessages.provider,
            subject: claimMessages.subject,
            from_addr: claimMessages.from_addr,
            body_text: claimMessages.body_text,
            received_at: claimMessages.received_at,
          })
          .from(claimMessages)
          .where(
            and(
              eq(claimMessages.case_id, caseId),
              eq(claimMessages.direction, "inbound")
            )
          )
          .orderBy(asc(claimMessages.received_at))
          .limit(MESSAGES_LIMIT)
      );
    } catch (e) {
      console.error("[GET /api/cases/:id/messages] messages query error:", dbErrCode(e)); // crew-debug-ok
      return err(new AppError("INTERNAL_ERROR"));
    }

    // AC14: count attachments linked to each message (was a PostgREST join).
    const attachmentCounts = new Map<string, number>();
    if (messages.length > 0) {
      try {
        const attachmentRows = await enTenant(tenantCtx, (db) =>
          db
            .select({ claim_message_id: claimAttachments.claim_message_id })
            .from(claimAttachments)
            .where(
              and(
                eq(claimAttachments.case_id, caseId),
                isNotNull(claimAttachments.claim_message_id),
                inArray(
                  claimAttachments.claim_message_id,
                  messages.map((m) => m.id)
                )
              )
            )
        );

        for (const row of attachmentRows) {
          if (!row.claim_message_id) continue;
          attachmentCounts.set(
            row.claim_message_id,
            (attachmentCounts.get(row.claim_message_id) ?? 0) + 1
          );
        }
      } catch (e) {
        console.error("[GET /api/cases/:id/messages] messages query error:", dbErrCode(e)); // crew-debug-ok
        return err(new AppError("INTERNAL_ERROR"));
      }
    }

    const result = messages.map((msg) => ({
      id: msg.id,
      direction: msg.direction,
      provider: msg.provider,
      subject: msg.subject,
      from_addr: msg.from_addr,
      // Truncate body_text server-side — AC13 (first 500 chars max).
      // PII: body_text is never logged — only truncated and forwarded.
      body_text:
        msg.body_text != null && msg.body_text.length > BODY_TEXT_MAX_CHARS
          ? msg.body_text.slice(0, BODY_TEXT_MAX_CHARS)
          : msg.body_text,
      received_at: msg.received_at,
      // AC14: count attachments linked to this message.
      attachment_count: attachmentCounts.get(msg.id) ?? 0,
    }));

    return ok({ messages: result });
  } catch (error) {
    const errName = error instanceof Error ? error.name : "UnknownError";
    console.error("[GET /api/cases/:id/messages] unhandled error:", errName); // crew-debug-ok
    return err(new AppError("INTERNAL_ERROR"));
  }
}
