/**
 * GET /api/policies — las pólizas de la aseguradora de la sesión.
 *
 * Filtros: customer_id, policy_number, status. Paginado. Trae el nombre del
 * cliente por join.
 *
 * Auth: los mismos roles que el padrón de clientes. Un número de póliza permite
 * cruzar a la persona, así que la puerta es la misma.
 * Límite: CASES_API (100/min).
 *
 * Respuesta 200: { data: Policy[], meta: { total, page, per_page, pages } }
 *
 * Lo que consulta vive en `@/server/policies/list`.
 */

import { type NextRequest } from "next/server";

import { ok, err } from "@/lib/api/respond";
import { requireRole, CUSTOMER_PII_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { AppError } from "@/lib/errors";
import { rateLimit, RATE_LIMIT_CONFIGS, buildUserKey } from "@/lib/rate-limit/index";
import { PolicyQuerySchema, listPolicies } from "@/server/policies/list";

export async function GET(request: NextRequest) {
  // ── 1. Sesión y rol ───────────────────────────────────────────────────────
  let ctx: RoleContext;
  try {
    ctx = await requireRole(...CUSTOMER_PII_ROLES);
  } catch (e) {
    return err(e instanceof AppError ? e : new AppError("INTERNAL_ERROR"));
  }
  const { user, userRow } = ctx;

  // ── 2. Límite de tráfico ──────────────────────────────────────────────────
  const rl = await rateLimit(
    buildUserKey(user.id, "policies-list"),
    RATE_LIMIT_CONFIGS.CASES_API
  );
  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes. Esperá un momento."));
  }

  // ── 3. Parámetros ─────────────────────────────────────────────────────────
  const searchParams = request.nextUrl.searchParams;
  const parsed = PolicyQuerySchema.safeParse({
    customer_id: searchParams.get("customer_id") ?? undefined,
    policy_number: searchParams.get("policy_number") ?? undefined,
    status: searchParams.get("status") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    per_page: searchParams.get("per_page") ?? undefined,
  });

  if (!parsed.success) {
    return err(
      new AppError(
        "VALIDATION_FAILED",
        "Parámetros de búsqueda inválidos.",
        parsed.error.flatten().fieldErrors
      )
    );
  }

  // ── 4. Datos ──────────────────────────────────────────────────────────────
  try {
    return ok(await listPolicies({ tenantId: userRow.tenant_id }, parsed.data));
  } catch (error) {
    const errName = error instanceof Error ? error.name : "UnknownError";
    console.error("[GET /api/policies] unhandled error:", errName);
    return err(new AppError("INTERNAL_ERROR"));
  }
}
