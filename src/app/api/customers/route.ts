/**
 * GET /api/customers — list customers for the authenticated user's tenant.
 *
 * AC18: Supports filters: search (full_name ILIKE), dni, email.
 * RLS is enforced by the user-scoped Supabase client — no manual tenant_id filter needed.
 *
 * Auth: yes (any authenticated user)
 * Rate limit: CASES_API config (100/min — shared with cases list)
 *
 * Response 200: { data: Customer[], meta: { total, page, per_page, pages } }
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

const CustomerQuerySchema = z.object({
  search: z.string().max(200).optional(),
  dni: z.string().max(20).optional(),
  email: z.string().email().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

type CustomerQuery = z.infer<typeof CustomerQuerySchema>;

// ── GET /api/customers ────────────────────────────────────────────────────────

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
  const rlKey = buildUserKey(user.id, "customers-list");
  const rl = await rateLimit(rlKey, RATE_LIMIT_CONFIGS.CASES_API);
  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes. Esperá un momento."));
  }

  // ── 3. Parse query params ─────────────────────────────────────────────────
  const searchParams = request.nextUrl.searchParams;
  const rawQuery = {
    search: searchParams.get("search") ?? undefined,
    dni: searchParams.get("dni") ?? undefined,
    email: searchParams.get("email") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    per_page: searchParams.get("per_page") ?? undefined,
  };

  const parsed = CustomerQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    return err(
      new AppError(
        "VALIDATION_FAILED",
        "Parámetros de búsqueda inválidos.",
        parsed.error.flatten().fieldErrors
      )
    );
  }

  const { search, dni, email, page, per_page } = parsed.data;

  // ── 4. Query (RLS-scoped) ─────────────────────────────────────────────────
  try {
    const selectColumns = [
      "id",
      "full_name",
      "dni",
      "email",
      "phone",
      "created_at",
    ].join(", ");

    // Count query
    let countQ = (supabase as any)
      .from("customers")
      .select("id", { count: "exact", head: true });

    if (search) {
      countQ = countQ.ilike("full_name", `%${search}%`);
    }
    if (dni) {
      countQ = countQ.eq("dni", dni);
    }
    if (email) {
      countQ = countQ.eq("email", email);
    }

    const { count, error: countError } = await countQ;
    if (countError) {
      console.error("[GET /api/customers] count error:", countError.code);
      return err(new AppError("INTERNAL_ERROR"));
    }

    const total = count ?? 0;

    // Data query
    let dataQ = (supabase as any)
      .from("customers")
      .select(selectColumns)
      .order("created_at", { ascending: false });

    if (search) {
      dataQ = dataQ.ilike("full_name", `%${search}%`);
    }
    if (dni) {
      dataQ = dataQ.eq("dni", dni);
    }
    if (email) {
      dataQ = dataQ.eq("email", email);
    }

    // Pagination
    const from = (page - 1) * per_page;
    const to = from + per_page - 1;
    dataQ = dataQ.range(from, to);

    const { data, error: dataError } = await dataQ;
    if (dataError) {
      console.error("[GET /api/customers] data error:", dataError.code);
      return err(new AppError("INTERNAL_ERROR"));
    }

    return ok({
      data: data ?? [],
      meta: {
        total,
        page,
        per_page,
        pages: Math.ceil(total / per_page),
      },
    });
  } catch (error) {
    const errName = error instanceof Error ? error.name : "UnknownError";
    console.error("[GET /api/customers] unhandled error:", errName);
    return err(new AppError("INTERNAL_ERROR"));
  }
}
