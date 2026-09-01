/**
 * GET /api/customers — el padrón de clientes de la aseguradora de la sesión.
 *
 * Filtros: search (nombre, correo o DNI, como la caja de la pantalla), y
 * `dni` / `email` como coincidencia exacta. Paginado.
 *
 * Auth: rol con acceso a datos personales (owner / admin / especialista). Un
 * analista NO entra: acá salen DNI, correo y teléfono.
 * Límite: CASES_API (100/min, compartido con el listado de casos).
 *
 * Respuesta 200: { data: Customer[], meta: { total, page, per_page, pages } }
 *
 * Lo que consulta vive en `@/server/customers/list`. Este archivo es el borde
 * HTTP y nada más: quién entra, cuánto puede pedir, y qué forma tiene lo que
 * sale.
 */

import { type NextRequest } from "next/server";

import { ok, err } from "@/lib/api/respond";
import { requireRole, CUSTOMER_PII_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { AppError } from "@/lib/errors";
import { rateLimit, RATE_LIMIT_CONFIGS, buildUserKey } from "@/lib/rate-limit/index";
import { CustomerQuerySchema, listCustomers } from "@/server/customers/list";

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
    buildUserKey(user.id, "customers-list"),
    RATE_LIMIT_CONFIGS.CASES_API
  );
  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes. Esperá un momento."));
  }

  // ── 3. Parámetros ─────────────────────────────────────────────────────────
  const searchParams = request.nextUrl.searchParams;
  const parsed = CustomerQuerySchema.safeParse({
    search: searchParams.get("search") ?? undefined,
    dni: searchParams.get("dni") ?? undefined,
    email: searchParams.get("email") ?? undefined,
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
    return ok(await listCustomers({ tenantId: userRow.tenant_id }, parsed.data));
  } catch (error) {
    const errName = error instanceof Error ? error.name : "UnknownError";
    console.error("[GET /api/customers] unhandled error:", errName);
    return err(new AppError("INTERNAL_ERROR"));
  }
}
