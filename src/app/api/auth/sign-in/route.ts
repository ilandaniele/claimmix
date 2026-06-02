/**
 * POST /api/auth/sign-in
 *
 * Signs in an analyst with email + password via Supabase Auth.
 *
 * AC1: 200 + session cookie (HttpOnly, Secure, SameSite=Lax) + audit log.
 * AC3: 6th attempt within 10s from same IP+email -> 429 with Retry-After header.
 *
 * Rate-limit key: IP + email (prevents both per-IP flooding and per-email brute force).
 *
 * Session cookies are set by @supabase/ssr automatically when calling
 * supabase.auth.signInWithPassword — the createServerClient factory wires up
 * the cookie store in the route handler context.
 */

import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";

type UserRow = Database["public"]["Tables"]["users"]["Row"];
import { SignInSchema } from "@/lib/schemas/auth";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildSignInKey,
  getClientIp,
} from "@/lib/rate-limit/index";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";

export async function POST(request: NextRequest) {
  // ── 1. Parse and validate request body ────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err(new AppError("VALIDATION_FAILED", "El cuerpo de la solicitud no es JSON válido."));
  }

  const parsed = SignInSchema.safeParse(body);
  if (!parsed.success) {
    return err(
      new AppError(
        "VALIDATION_FAILED",
        "Los datos enviados no son válidos.",
        parsed.error.flatten().fieldErrors
      )
    );
  }

  const { email, password } = parsed.data;
  const ip = getClientIp(request);
  const ua = request.headers.get("user-agent") ?? null;

  // ── 2. Rate limiting (AC3) ─────────────────────────────────────────────────
  const rateLimitKey = buildSignInKey(ip, email);
  const rl = await rateLimit(rateLimitKey, RATE_LIMIT_CONFIGS.AUTH_SIGN_IN);

  if (!rl.allowed) {
    // Write rate_limited audit event. We don't have a tenant_id at this point
    // (user not authenticated yet), so we use a sentinel value '00000000-...'
    // and the actual tenant will be reconciled if needed.
    // For MVP: write with empty tenant_id as a string to satisfy NOT NULL.
    // The audit_log policy uses tenant_id from the service role (bypasses RLS).
    await writeAuditLog({
      tenant_id: "00000000-0000-0000-0000-000000000000",
      actor_id: null,
      event_type: AuditEvent.AUTH_RATE_LIMITED,
      target_type: "auth",
      target_id: null,
      payload: { email_hash: hashEmail(email), ip_prefix: ip.split(".").slice(0, 3).join(".") },
      ip,
      ua,
    });

    const rateLimitedResponse = NextResponse.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "Demasiados intentos. Intente en 10 segundos.",
        },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rl.retryAfterSeconds),
          "X-RateLimit-Limit": String(RATE_LIMIT_CONFIGS.AUTH_SIGN_IN.limit),
          "X-RateLimit-Remaining": String(rl.remaining),
          "X-RateLimit-Reset": String(Math.ceil(rl.resetAt / 1000)),
        },
      }
    );
    return rateLimitedResponse;
  }

  // ── 3. Attempt sign-in via Supabase Auth ───────────────────────────────────
  const supabase = await createServerClient();
  const { data, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !data.session || !data.user) {
    // Log auth failure (no tenant_id available at this stage).
    await writeAuditLog({
      tenant_id: "00000000-0000-0000-0000-000000000000",
      actor_id: null,
      event_type: AuditEvent.AUTH_FAILURE,
      target_type: "auth",
      target_id: null,
      payload: { ip_prefix: ip.split(".").slice(0, 3).join(".") },
      ip,
      ua,
    });

    return err(new AppError("INVALID_CREDENTIALS", "Credenciales inválidas."));
  }

  // ── 4. Fetch the analyst's public.users row (for tenant_id + role) ─────────
  const { data: userRowRaw } = await supabase
    .from("users")
    .select("*")
    .eq("id", data.user.id)
    .single();
  const userRow = userRowRaw as UserRow | null;

  const tenantId = userRow?.tenant_id ?? "00000000-0000-0000-0000-000000000000";

  // ── 5. Write success audit log ─────────────────────────────────────────────
  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: data.user.id,
    event_type: AuditEvent.AUTH_SUCCESS,
    target_type: "user",
    target_id: data.user.id,
    payload: { role: userRow?.role ?? "unknown" },
    ip,
    ua,
  });

  // ── 6. Return success ──────────────────────────────────────────────────────
  // The session cookie was set by the Supabase SSR client in createServerClient().
  // We return 200 with minimal user info — the session cookie is in the response.
  return NextResponse.json(
    {
      user: {
        id: data.user.id,
        email: data.user.email,
        full_name: userRow?.full_name ?? null,
        role: userRow?.role ?? null,
        tenant_id: tenantId,
      },
      redirect: "/bandeja",
    },
    { status: 200 }
  );
}

/**
 * One-way hash of email for audit log (prevents storing PII in audit payload).
 * Not cryptographically secure — used for correlation only.
 */
function hashEmail(email: string): string {
  // Simple deterministic truncation — not a real hash.
  // Replace with crypto.subtle.digest('SHA-256') if needed.
  const normalized = email.toLowerCase().trim();
  return `${normalized.slice(0, 3)}***@${normalized.split("@")[1] ?? "unknown"}`;
}
