/**
 * GET /api/customers — list customers for the authenticated user's tenant.
 *
 * AC18: Supports filters: search (full_name ILIKE), dni, email.
 * Tenant isolation is enforced with an explicit tenant_id filter (RLS is gone).
 *
 * Auth: yes (any authenticated user)
 * Rate limit: CASES_API config (100/min — shared with cases list)
 *
 * Response 200: { data: Customer[], meta: { total, page, per_page, pages } }
 */

import { type NextRequest } from "next/server";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { countRows, firstRow, ilikeAny } from "@/lib/db/helpers";
import { customers, users } from "@/lib/db/schema";
import { getSessionContext } from "@/lib/auth/session";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { CUSTOMER_PII_ROLES } from "@/lib/auth/require-role";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
} from "@/lib/rate-limit/index";
import { z } from "zod";
import { enTenant } from "@/data/scope";

// ── Query schema ──────────────────────────────────────────────────────────────

const CustomerQuerySchema = z.object({
  search: z.string().max(200).optional(),
  dni: z.string().max(20).optional(),
  email: z.string().email().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

// ── GET /api/customers ────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  // ── 1. Auth ───────────────────────────────────────────────────────────────
  const session = await getSessionContext();
  const user = session?.user;

  if (!user) {
    return err(new AppError("MISSING_SESSION", "Se requiere autenticación."));
  }

  // ── 1b. Role check — admin or specialist only (API5) ─────────────────────
  // Customer data contains PII (DNI, email, phone). Only privileged roles may
  // enumerate this endpoint. Analysts may not access it.
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
  if (!userRow || !(CUSTOMER_PII_ROLES as string[]).includes(role)) {
    return err(
      new AppError(
        "FORBIDDEN_ROLE",
        "Solo administradores o especialistas pueden listar clientes."
      )
    );
  }

  const tenantId = userRow.tenant_id;

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

  // ── 4. Query (explicitly tenant-scoped) ───────────────────────────────────
  try {
    const conditions: SQL[] = [eq(customers.tenant_id, tenantId)];
    if (search) {
      const searchCond = ilikeAny([customers.full_name], search);
      if (searchCond) conditions.push(searchCond);
    }
    if (dni) conditions.push(eq(customers.dni, dni));
    if (email) conditions.push(eq(customers.email, email));

    const where = and(...conditions);

    // Count query
    //
    // Por `countRows` y no por `db.$count` adentro de `enTenant`: eso ultimo no
    // devuelve una consulta sino un objeto que se puede esperar, y la capa manda
    // todo por `batch()`, que necesita armarla. Reventaba con
    // "query._prepare is not a function" en cada listado.
    const total = await countRows({ tenantId }, customers, where);

    // Data query
    const from = (page - 1) * per_page;
    const data = await enTenant({ tenantId }, (db) =>
      db
        .select({
          id: customers.id,
          full_name: customers.full_name,
          dni: customers.dni,
          email: customers.email,
          phone: customers.phone,
          created_at: customers.created_at,
        })
        .from(customers)
        .where(where)
        .orderBy(desc(customers.created_at))
        .limit(per_page)
        .offset(from)
    );

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
    console.error("[GET /api/customers] unhandled error:", errName);
    return err(new AppError("INTERNAL_ERROR"));
  }
}
