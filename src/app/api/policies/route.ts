/**
 * GET /api/policies — list policies for the authenticated user's tenant.
 *
 * AC18: Supports filters: customer_id, policy_number, status (active/inactive/expired/cancelled).
 * Returns: id, policy_number, policy_type, status, customer_id, customer full_name (joined).
 * RLS is enforced by the user-scoped Supabase client.
 *
 * Auth: yes (any authenticated user)
 * Rate limit: CASES_API config (100/min)
 *
 * Response 200: { data: Policy[], meta: { total, page, per_page, pages } }
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

// ── Query schema ──────────────────────────────────────────────────────────────

const PolicyQuerySchema = z.object({
  customer_id: z.string().uuid().optional(),
  policy_number: z.string().max(100).optional(),
  status: z.enum(["active", "expired", "cancelled"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

// ── GET /api/policies ─────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  // ── 1. Auth ───────────────────────────────────────────────────────────────
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return err(new AppError("MISSING_SESSION", "Se requiere autenticación."));
  }

  // ── 2. Rate limit ─────────────────────────────────────────────────────────
  const rlKey = buildUserKey(user.id, "policies-list");
  const rl = await rateLimit(rlKey, RATE_LIMIT_CONFIGS.CASES_API);
  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes. Esperá un momento."));
  }

  // ── 3. Parse query params ─────────────────────────────────────────────────
  const searchParams = request.nextUrl.searchParams;
  const rawQuery = {
    customer_id: searchParams.get("customer_id") ?? undefined,
    policy_number: searchParams.get("policy_number") ?? undefined,
    status: searchParams.get("status") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    per_page: searchParams.get("per_page") ?? undefined,
  };

  const parsed = PolicyQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    return err(
      new AppError(
        "VALIDATION_FAILED",
        "Parámetros de búsqueda inválidos.",
        parsed.error.flatten().fieldErrors
      )
    );
  }

  const { customer_id, policy_number, status, page, per_page } = parsed.data;

  // ── 4. Query (RLS-scoped) ─────────────────────────────────────────────────
  try {
    // Join with customers to return customer_name.
    // Supabase syntax: "policies(*,customers(full_name)"
    const selectColumns =
      "id, policy_number, policy_type, status, customer_id, valid_from, valid_to, created_at, customers(full_name)";

    // Count query
    let countQ = (supabase as any)
      .from("policies")
      .select("id", { count: "exact", head: true });

    if (customer_id) countQ = countQ.eq("customer_id", customer_id);
    if (policy_number) countQ = countQ.eq("policy_number", policy_number);
    if (status) countQ = countQ.eq("status", status);

    const { count, error: countError } = await countQ;
    if (countError) {
      console.error("[GET /api/policies] count error:", countError.code);
      return err(new AppError("INTERNAL_ERROR"));
    }

    const total = count ?? 0;

    // Data query with customer join
    let dataQ = (supabase as any)
      .from("policies")
      .select(selectColumns)
      .order("created_at", { ascending: false });

    if (customer_id) dataQ = dataQ.eq("customer_id", customer_id);
    if (policy_number) dataQ = dataQ.eq("policy_number", policy_number);
    if (status) dataQ = dataQ.eq("status", status);

    // Pagination
    const from = (page - 1) * per_page;
    const to = from + per_page - 1;
    dataQ = dataQ.range(from, to);

    const { data: rawData, error: dataError } = await dataQ;
    if (dataError) {
      console.error("[GET /api/policies] data error:", dataError.code);
      return err(new AppError("INTERNAL_ERROR"));
    }

    // Flatten the nested customers join into a customer_name field.
    const data = (rawData ?? []).map((row: any) => ({
      id: row.id,
      policy_number: row.policy_number,
      policy_type: row.policy_type,
      status: row.status,
      customer_id: row.customer_id,
      customer_name: row.customers?.full_name ?? null,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      created_at: row.created_at,
    }));

    return ok({
      data,
      meta: {
        total,
        page,
        per_page,
        pages: Math.ceil(total / per_page),
      },
    });
  } catch (error) {
    const errName = error instanceof Error ? error.name : "UnknownError";
    console.error("[GET /api/policies] unhandled error:", errName);
    return err(new AppError("INTERNAL_ERROR"));
  }
}
