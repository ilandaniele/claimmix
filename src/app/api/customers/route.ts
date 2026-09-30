/**
 * GET /api/customers — el padrón de clientes de la aseguradora de la sesión.
 * POST /api/customers — da de alta un cliente a mano (B16); más abajo.
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

import { ClienteNuevoSchema } from "@/core/padron/manual";
import { enTenant } from "@/data/scope";
import { ok, err, created } from "@/lib/api/respond";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { firstRow } from "@/lib/db/helpers";
import { CUSTOMER_PII_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { entrar } from "@/lib/api/entrada";
import { AppError } from "@/lib/errors";
import { RATE_LIMIT_CONFIGS, type RateLimitResult } from "@/lib/rate-limit/index";
import { CustomerQuerySchema, listCustomers } from "@/server/customers/list";
import { logger } from "@/lib/observability/logger";
import { codigoPg } from "@/server/core-sync/config";
import { camposPresentes, entrarAEscribir, leerCuerpo, rechazo } from "@/server/padron/escritura";
import { consultaAltaCliente } from "@/server/padron/manual";

export async function GET(request: NextRequest) {
  // ── 1. Sesión y rol ───────────────────────────────────────────────────────
  let ctx: RoleContext;
  let rl: RateLimitResult;
  try {
    ({ ctx, rl } = await entrar("customers-list", RATE_LIMIT_CONFIGS.CASES_API, ...CUSTOMER_PII_ROLES));
  } catch (e) {
    return err(e instanceof AppError ? e : new AppError("INTERNAL_ERROR"));
  }
  const { userRow } = ctx;

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
    logger.error({ error_name: errName }, "get_api_customers.unhandled_error");
    return err(new AppError("INTERNAL_ERROR"));
  }
}

/**
 * POST /api/customers — un cliente nuevo, con nombre y DNI. El DNI no se cambia
 * después. Un DNI que ya está en el padrón no es un conflicto: es un dato
 * inválido, y se dice cuál.
 *
 * Auth: quienes editan el padrón. El inquilino sale de la sesión, nunca del cuerpo.
 * Respuesta 201: { id }
 */
export async function POST(request: NextRequest) {
  try {
    const { userRow, t } = await entrarAEscribir();
    const cuerpo = await leerCuerpo(request, ClienteNuevoSchema, t);
    if (!cuerpo.ok) return cuerpo.respuesta;

    const tenantId = userRow.tenant_id;
    let fila;
    try {
      fila = firstRow(await enTenant({ tenantId }, (db) => consultaAltaCliente(db, tenantId, cuerpo.datos)));
    } catch (e) {
      if (codigoPg(e) === "23505") return rechazo(t, ["dni_existente"]);
      throw e;
    }
    if (!fila) throw new AppError("INTERNAL_ERROR");

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userRow.id,
      event_type: AuditEvent.CLIENTE_ALTA,
      target_type: "customer",
      target_id: fila.id,
      payload: { campos: camposPresentes(cuerpo.datos) },
    });
    return created({ id: fila.id });
  } catch (e) {
    return err(e);
  }
}
