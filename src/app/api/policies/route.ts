/**
 * GET /api/policies — las pólizas de la aseguradora de la sesión.
 * POST /api/policies — da de alta una póliza a mano (B16); más abajo.
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

import { PolizaNuevaSchema } from "@/core/padron/manual";
import { enTenant } from "@/data/scope";
import { ok, err, created } from "@/lib/api/respond";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { firstRow } from "@/lib/db/helpers";
import { CUSTOMER_PII_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { entrar } from "@/lib/api/entrada";
import { AppError } from "@/lib/errors";
import { RATE_LIMIT_CONFIGS, type RateLimitResult } from "@/lib/rate-limit/index";
import { PolicyQuerySchema, listPolicies } from "@/server/policies/list";
import { logger } from "@/lib/observability/logger";
import { codigoPg } from "@/server/core-sync/config";
import { camposPresentes, entrarAEscribir, leerCuerpo, rechazo } from "@/server/padron/escritura";
import { consultaAltaPoliza } from "@/server/padron/manual";

export async function GET(request: NextRequest) {
  // ── 1. Sesión y rol ───────────────────────────────────────────────────────
  let ctx: RoleContext;
  let rl: RateLimitResult;
  try {
    ({ ctx, rl } = await entrar("policies-list", RATE_LIMIT_CONFIGS.CASES_API, ...CUSTOMER_PII_ROLES));
  } catch (e) {
    return err(e instanceof AppError ? e : new AppError("INTERNAL_ERROR"));
  }
  const { userRow } = ctx;

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
    logger.error({ error_name: errName }, "get_api_policies.unhandled_error");
    return err(new AppError("INTERNAL_ERROR"));
  }
}

/**
 * POST /api/policies — una póliza nueva de un cliente que ya está en el padrón.
 * Sin ramo queda como «other»; sin estado, como activa. El número y el titular
 * no se cambian después. Un número que ya existe es un dato inválido, no un
 * conflicto.
 *
 * Auth: quienes editan el padrón. El inquilino sale de la sesión; el cliente
 * tiene que ser de ese inquilino (lo garantiza la consulta, no una lectura previa).
 * Respuesta 201: { id }
 */
export async function POST(request: NextRequest) {
  try {
    const { userRow, t } = await entrarAEscribir();
    const cuerpo = await leerCuerpo(request, PolizaNuevaSchema, t);
    if (!cuerpo.ok) return cuerpo.respuesta;

    const tenantId = userRow.tenant_id;
    let fila;
    try {
      fila = firstRow(await enTenant({ tenantId }, (db) => consultaAltaPoliza(db, cuerpo.datos)));
    } catch (e) {
      if (codigoPg(e) === "23505") return rechazo(t, ["poliza_existente"]);
      throw e;
    }
    if (!fila) return rechazo(t, ["cliente_no_existe"]);

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userRow.id,
      event_type: AuditEvent.POLIZA_ALTA,
      target_type: "policy",
      target_id: fila.id,
      payload: { campos: camposPresentes(cuerpo.datos) },
    });
    return created({ id: fila.id });
  } catch (e) {
    return err(e);
  }
}
