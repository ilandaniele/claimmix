/**
 * GET /api/admin/gmail-status — Gmail poll state for the admin configuracion panel.
 *
 * AC1: Returns 200 with masked email, last_polled_at, is_connected, last_error when row exists.
 * AC2: Returns graceful empty shape when no row exists.
 * AC6: Non-admin users get 403 FORBIDDEN.
 * AC7: history_id is NEVER included in the response body.
 *
 * Security:
 *   - Auth: proxy.ts session guard + requireAdmin() checks role='admin' → 403 if not admin.
 *   - DB: createServiceClient() — gmail_poll_state has no user RLS policies (service-role required).
 *   - Rate limit: CASES_API (100 req/min per user) — reused per spec.
 *   - PII: gmail_account_email is masked before returning; never logged.
 *   - history_id is OMITTED entirely (AC7, IC2).
 */

import { requireAdmin } from "@/lib/auth/require-admin";
import { createServiceClient } from "@/lib/supabase/service";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { maskEmail } from "@/lib/email/mask";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
} from "@/lib/rate-limit/index";

/** Shape returned by this endpoint. history_id is intentionally omitted. */
export interface GmailStatusResponse {
  email_address: string | null;
  last_polled_at: string | null;
  is_connected: boolean;
  last_error: string | null;
}

/** Graceful empty shape (no row in gmail_poll_state). */
const EMPTY_RESPONSE: GmailStatusResponse = {
  email_address: null,
  last_polled_at: null,
  is_connected: false,
  last_error: null,
};

export async function GET() {
  try {
    // ── 1. Auth + admin role check ────────────────────────────────────────────
    const { user } = await requireAdmin();

    // ── 2. Rate limit ─────────────────────────────────────────────────────────
    const rateLimitResult = await rateLimit(
      buildUserKey(user.id, "admin/gmail-status"),
      RATE_LIMIT_CONFIGS.CASES_API
    );
    if (!rateLimitResult.allowed) {
      return err(new AppError("RATE_LIMITED"));
    }

    // ── 3. DB — service client (gmail_poll_state has no user RLS policies) ────
    const serviceClient = createServiceClient();

    // MVP: single row — order by updated_at desc, take the most recent.
    // Using type assertion because the generated types don't yet include gmail_poll_state.
    const serviceAny = serviceClient as ReturnType<typeof createServiceClient> & Record<string, unknown>;
    const { data: row, error: dbError } = await (serviceAny as any)
      .from("gmail_poll_state")
      .select("gmail_account_email, last_polled_at, last_error")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle() as {
        data: {
          gmail_account_email: string;
          last_polled_at: string | null;
          last_error: string | null;
        } | null;
        error: { code: string; message: string } | null;
      };

    if (dbError) {
      // Log only the error code — never the row data or PII.
      console.error("[admin/gmail-status GET]", dbError.code); // crew-debug-ok
      return err(new AppError("INTERNAL_ERROR"));
    }

    // ── 4. No row — return graceful empty ─────────────────────────────────────
    if (!row) {
      return ok(EMPTY_RESPONSE);
    }

    // ── 5. Build response — mask PII, derive is_connected, omit history_id ────
    const isConnected: boolean =
      row.last_polled_at !== null && row.last_error === null;

    const response: GmailStatusResponse = {
      // IC3: email masked to g***@domain.com before leaving the server.
      // NEVER log row.gmail_account_email — it is PII-adjacent.
      email_address: maskEmail(row.gmail_account_email),
      last_polled_at: row.last_polled_at,
      is_connected: isConnected,
      last_error: row.last_error,
    };

    return ok(response);
  } catch (e) {
    return err(e);
  }
}
