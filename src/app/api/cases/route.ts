/**
 * GET /api/cases — list cases with filtering, pagination, and sorting.
 *
 * AC9:  Tenant-isolated by explicit tenant_id filter (RLS is gone).
 * AC11: Filter by claim type returns only matching cases.
 * AC12: Pagination per_page capped at 100.
 *
 * Rate limit: 100 req/min per user (CASES_API config).
 *
 * Response shape:
 *   { data: Case[], meta: { total, page, per_page, pages } }
 *
 * raw_intake_text is NOT included in the list response (large field, not needed).
 */

import { type NextRequest } from "next/server";
import { requireRole, ALL_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { CaseQuerySchema } from "@/lib/schemas/cases";
import { listCases } from "@/server/cases/list";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
  getClientIp,
} from "@/lib/rate-limit/index";

export async function GET(request: NextRequest) {
  // ── 1. Auth — Better Auth session + public.users row ──────────────────────
  let ctx: RoleContext;
  try {
    ctx = await requireRole(...ALL_ROLES);
  } catch (e) {
    return err(e instanceof AppError ? e : new AppError("INTERNAL_ERROR"));
  }
  const { user, userRow } = ctx;

  // ── 2. Rate limit — 100 req/min per user ──────────────────────────────────
  const ip = getClientIp(request);
  const rlKey = buildUserKey(user.id, "cases-list");
  const rl = await rateLimit(rlKey, RATE_LIMIT_CONFIGS.CASES_API);

  if (!rl.allowed) {
    return err(
      new AppError("RATE_LIMITED", "Demasiadas solicitudes. Esperá un momento.")
    );
  }

  // ── 3. Parse and validate query params ────────────────────────────────────
  const searchParams = request.nextUrl.searchParams;
  // AC18: Extended with email-intake filters (severity, customer_id, policy_id, channel, is_claim)
  const rawQuery = {
    status: searchParams.get("status") ?? undefined,
    type: searchParams.get("type") ?? undefined,
    q: searchParams.get("q") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    per_page: searchParams.get("per_page") ?? undefined,
    sort: searchParams.get("sort") ?? undefined,
    order: searchParams.get("order") ?? undefined,
    // Email-intake filters (AC18)
    severity: searchParams.get("severity") ?? undefined,
    customer_id: searchParams.get("customer_id") ?? undefined,
    policy_id: searchParams.get("policy_id") ?? undefined,
    channel: searchParams.get("channel") ?? undefined,
    is_claim: searchParams.get("is_claim") ?? undefined,
  };

  const parsed = CaseQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    return err(
      new AppError(
        "VALIDATION_FAILED",
        "Parámetros de búsqueda inválidos.",
        parsed.error.flatten().fieldErrors
      )
    );
  }

  // ── 4. Fetch data (explicit tenant_id filter — RLS is gone) ───────────────
  try {
    const result = await listCases(userRow.tenant_id, parsed.data);
    // Drizzle numeric columns surface as strings — convert at the boundary so
    // the JSON shape matches the previous PostgREST response (numbers).
    return ok({
      ...result,
      data: result.data.map((c) => ({
        ...c,
        confidence_min:
          c.confidence_min === null ? null : Number(c.confidence_min),
      })),
    });
  } catch (error) {
    const errName = error instanceof Error ? error.name : "UnknownError";
    console.error("[GET /api/cases] query error:", errName, ip);
    return err(new AppError("INTERNAL_ERROR"));
  }
}
