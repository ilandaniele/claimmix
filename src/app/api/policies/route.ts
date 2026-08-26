/**
 * GET /api/policies — list policies for the authenticated user's tenant.
 *
 * AC18: Supports filters: customer_id, policy_number, status (active/inactive/expired/cancelled).
 * Returns: id, policy_number, policy_type, status, customer_id, customer full_name (joined).
 * Tenant isolation is enforced with an explicit tenant_id filter (RLS is gone).
 *
 * Auth: yes (any authenticated user)
 * Rate limit: CASES_API config (100/min)
 *
 * Response 200: { data: Policy[], meta: { total, page, per_page, pages } }
 */

import { type NextRequest } from "next/server";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { customers, policies, users } from "@/lib/db/schema";
import { getSessionContext } from "@/lib/auth/session";
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
  const session = await getSessionContext();
  const user = session?.user;

  if (!user) {
    return err(new AppError("MISSING_SESSION", "Se requiere autenticación."));
  }

  // ── 1b. Role check — admin or specialist only (API5) ─────────────────────
  // Policy data contains sensitive information (policy_number, coverage details).
  // Only privileged roles may enumerate this endpoint. Analysts may not access it.
  const userRow = firstRow(
    // sin-inquilino: Ésta es la consulta que AVERIGUA de qué inquilino es la sesión.
    // No puede pasar por una capa que necesita el dato que ella busca.
    await db
      .select({ role: users.role, tenant_id: users.tenant_id })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)
  );

  const role: string = userRow?.role ?? "analyst";
  if (!userRow || !["admin", "specialist"].includes(role)) {
    return err(
      new AppError(
        "FORBIDDEN_ROLE",
        "Solo administradores o especialistas pueden listar pólizas."
      )
    );
  }

  const tenantId = userRow.tenant_id;

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

  // ── 4. Query (explicitly tenant-scoped) ───────────────────────────────────
  try {
    const conditions: SQL[] = [eq(policies.tenant_id, tenantId)];
    if (customer_id) conditions.push(eq(policies.customer_id, customer_id));
    if (policy_number) conditions.push(eq(policies.policy_number, policy_number));
    if (status) conditions.push(eq(policies.status, status));

    const where = and(...conditions);

    // Count query
    const total = await db.$count(policies, where);

    // Data query with customer join (schema columns are start_date/end_date;
    // the API contract keeps exposing them as valid_from/valid_to).
    const from = (page - 1) * per_page;
    const rawData = await db
      .select({
        id: policies.id,
        policy_number: policies.policy_number,
        policy_type: policies.policy_type,
        status: policies.status,
        customer_id: policies.customer_id,
        valid_from: policies.start_date,
        valid_to: policies.end_date,
        created_at: policies.created_at,
        customer_name: customers.full_name,
      })
      .from(policies)
      .leftJoin(customers, eq(customers.id, policies.customer_id))
      .where(where)
      .orderBy(desc(policies.created_at))
      .limit(per_page)
      .offset(from);

    const data = rawData.map((row) => ({
      id: row.id,
      policy_number: row.policy_number,
      policy_type: row.policy_type,
      status: row.status,
      customer_id: row.customer_id,
      customer_name: row.customer_name ?? null,
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
