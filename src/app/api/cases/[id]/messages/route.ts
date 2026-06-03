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
 * - Auth: user-scoped Supabase client (RLS enforced) — no service-role needed.
 * - IDOR: case ownership verified first (404 not 403 for wrong-tenant).
 * - PII: from_addr, subject, body_text are PII — NEVER logged.
 * - Rate limit: CASES_API (100/min per user).
 */

import { type NextRequest } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
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

// ── GET /api/cases/:id/messages ───────────────────────────────────────────────

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  // ── 1. Auth ───────────────────────────────────────────────────────────────
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return err(new AppError("MISSING_SESSION", "Se requiere autenticación."));
  }

  // ── 2. Rate limit ─────────────────────────────────────────────────────────
  const rlKey = buildUserKey(user.id, "cases-messages-get");
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
  //    RLS scopes this query to the authenticated user's tenant automatically.
  //    If the case belongs to another tenant, RLS returns no row → 404.
  try {
    const { data: caseRow, error: caseError } = await (supabase as any)
      .from("cases")
      .select("id")
      .eq("id", caseId)
      .maybeSingle();

    if (caseError) {
      console.error("[GET /api/cases/:id/messages] case lookup error:", caseError.code);
      return err(new AppError("INTERNAL_ERROR"));
    }

    if (!caseRow) {
      // Case not found OR belongs to different tenant — always 404, never 403.
      return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
    }

    // ── 5. Fetch inbound messages with attachment counts ────────────────────
    //    body_text truncated server-side to BODY_TEXT_MAX_CHARS.
    //    attachment_count is aggregated via a join to claim_attachments.
    const { data: messages, error: msgError } = await (supabase as any)
      .from("claim_messages")
      .select(
        `
        id,
        direction,
        provider,
        subject,
        from_addr,
        body_text,
        received_at,
        claim_attachments!claim_attachments_claim_message_id_fkey(id)
        `
      )
      .eq("case_id", caseId)
      .eq("direction", "inbound")
      .order("received_at", { ascending: true })
      .limit(MESSAGES_LIMIT);

    if (msgError) {
      console.error("[GET /api/cases/:id/messages] messages query error:", msgError.code);
      return err(new AppError("INTERNAL_ERROR"));
    }

    const result = (messages ?? []).map(
      (msg: {
        id: string;
        direction: string;
        provider: string;
        subject: string | null;
        from_addr: string | null;
        body_text: string | null;
        received_at: string;
        claim_attachments: Array<{ id: string }> | null;
      }) => ({
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
        attachment_count: Array.isArray(msg.claim_attachments)
          ? msg.claim_attachments.length
          : 0,
      })
    );

    return ok({ messages: result });
  } catch (error) {
    const errName = error instanceof Error ? error.name : "UnknownError";
    console.error("[GET /api/cases/:id/messages] unhandled error:", errName);
    return err(new AppError("INTERNAL_ERROR"));
  }
}
