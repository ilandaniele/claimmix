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
import { z } from "zod";
import { deleteCases } from "@/server/cases/delete";

/** Hasta cien, que es el tope de la página: más no lo puede pedir la pantalla. */
const BorradoSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});
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
    const result = await listCases({ tenantId: userRow.tenant_id }, parsed.data);
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

// ── DELETE /api/cases ─────────────────────────────────────────────────────────

/**
 * Borrado múltiple, en un pedido y una transacción.
 *
 * La bandeja borraba mandando un DELETE por caso seleccionado. Con la página de
 * cien eso son cien pedidos que se comen el cupo del minuto entero, se
 * serializan por el lock del contador, y dejan un subconjunto arbitrario borrado
 * si uno falla a la mitad. Ver src/server/cases/delete.ts.
 *
 * Responde con los ids que de verdad se borraron. Un id de otra aseguradora no
 * coincide con ninguna fila —lo impide la base, no un chequeo previo— así que no
 * aparece en la respuesta, y quien llama compara contra lo que pidió. Devolver
 * 404 por la tanda entera sería peor: haría fallar un borrado legítimo de
 * noventa y nueve por un id que ya no estaba.
 */
export async function DELETE(request: NextRequest) {
  let rol: RoleContext;
  try {
    rol = await requireRole(...ALL_ROLES);
  } catch (e) {
    return err(e);
  }
  const { userRow } = rol;

  if (userRow.role === "viewer") {
    return err(new AppError("FORBIDDEN_ROLE", "Tu rol es de solo lectura."));
  }

  const rl = await rateLimit(
    buildUserKey(userRow.id, "cases-delete"),
    RATE_LIMIT_CONFIGS.CASES_API
  );
  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes."));
  }

  const cuerpo = (await request.json().catch(() => null)) as { ids?: unknown } | null;
  const parsed = BorradoSchema.safeParse(cuerpo);
  if (!parsed.success) {
    return err(
      new AppError(
        "VALIDATION_FAILED",
        "Se espera { ids: string[] } con al menos un identificador.",
        parsed.error.flatten().fieldErrors
      )
    );
  }

  try {
    const deleted = await deleteCases(
      { tenantId: userRow.tenant_id },
      parsed.data.ids
    );
    return ok({ deleted });
  } catch (error) {
    console.error(
      "[DELETE /api/cases]",
      error instanceof Error ? error.name : "UnknownError"
    );
    return err(new AppError("INTERNAL_ERROR"));
  }
}
