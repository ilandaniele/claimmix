/**
 * POST /api/cases/:id/sync-to-core — trigger CoreSyncService for a ready case.
 *
 * AC17: Invokes the CoreSyncClient that the tenant's `core_sync_settings` row
 *       picks (CORE_SYNC_MODE=mock overrides it for tests and the demo).
 *       On success: cases.status='enviado_a_core', cases.core_external_id populated.
 *       On failure: cases.status='error_core', cases.core_error_message populated.
 *       Audit log: CORE_SYNC_SUCCESS or CORE_SYNC_FAILED.
 *       Sin cliente configurado (sin fila, apagada o sin la 0036) responde 501
 *       sin escribir nada; el caso sale de ahí a mano (`SALIDAS_A_MANO`).
 *       Un caso simulado o de prueba también da 501 con el webhook real.
 *
 * Auth: CORE_SYNC_ROLES (owner, admin, specialist).
 * Rate limit: SYNC_TO_CORE config (5/min per user).
 * Precondition: cases.status must be 'listo_para_core'; with force=true also
 * 'error_core' (retry), and nothing else.
 */

import { and, eq, inArray } from "drizzle-orm";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { type RoleContext } from "@/lib/auth/require-role";
import { CORE_SYNC_ROLES } from "@/lib/auth/roles";
import { entrar } from "@/lib/api/entrada";
import { enTenant, enTenantVarias, type TenantContext } from "@/data/scope";
import { cases, extractedFields } from "@/lib/db/schema";
import { SyncToCoreSchema } from "@/lib/schemas/cases";
import {
  CoreSyncSinConfigurar,
  esModoMock,
  getCoreSyncClient,
  type FilaDeCoreSync,
  type ModoDeCoreSync,
} from "@/server/core-sync/client";
import { consultaDeLaConfig, esFaltaDe0036 } from "@/server/core-sync/config";
import { columnasDelCaso, esCasoReal } from "@/server/core-sync/lectura";
import { armarPayload, type CasoParaElCore } from "@/server/core-sync/payload";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { RATE_LIMIT_CONFIGS, type RateLimitResult } from "@/lib/rate-limit/index";
import { logger } from "@/lib/observability/logger";

const REQUIRED_STATUS = "listo_para_core";
const SUCCESS_STATUS = "enviado_a_core" as const;
const FAILURE_STATUS = "error_core" as const;

function sinConfigurar(caseId: string, modo: ModoDeCoreSync) {
  logger.warn({ case_id: caseId, modo }, "core_sync.sin_configurar");
  return err(
    new AppError(
      "NOT_IMPLEMENTED",
      "La integración con el sistema del asegurador no está configurada. El caso queda como está."
    )
  );
}

const ParamsSchema = z.object({
  id: z.guid("ID de caso inválido."),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  // ── 1. Auth — CORE_SYNC_ROLES ────────────────────────────────────────────────
  let ctx: RoleContext;
  let rl: RateLimitResult;
  try {
    ({ ctx, rl } = await entrar("sync-to-core", RATE_LIMIT_CONFIGS.SYNC_TO_CORE, ...CORE_SYNC_ROLES));
  } catch (e) {
    if (e instanceof AppError) return err(e);
    throw e;
  }
  const { userRow } = ctx;
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  // Este contexto es lo único que le dice de quién son los datos.
  const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };


  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes. Esperá un momento."));
  }

  // ── 3. Route params ───────────────────────────────────────────────────────────
  const rawParams = await context.params;
  const parsedParams = ParamsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    return err(new AppError("NOT_FOUND", "El caso no existe."));
  }
  const { id: caseId } = parsedParams.data;

  // ── 4. Request body ───────────────────────────────────────────────────────────
  const body = await request.json().catch(() => ({}));
  const parsed = SyncToCoreSchema.safeParse(body);
  if (!parsed.success) {
    return err(new AppError("VALIDATION_FAILED", "Los datos enviados no son válidos.", parsed.error.flatten().fieldErrors));
  }
  const { force } = parsed.data;

  // ── 5. Caso, campos y config de la aseguradora, en un solo viaje ────────────
  // Con el mock no se lee la config: ni la demo ni los tests dependen de la 0036.
  const mock = esModoMock();
  let filas: readonly unknown[];
  try {
    filas = await enTenantVarias<readonly unknown[]>(tenantCtx, (db) => [
      db
        .select({
          id: cases.id,
          status: cases.status,
          tenant_id: cases.tenant_id,
          claim_type: cases.claim_type,
          severity: cases.severity,
          policy_number: cases.policy_number,
          policyholder_name: cases.policyholder_name,
          // En ISO, como /api/v1: viaja en `updatedAt` y en X-ClaimMix-Event-Id.
          updated_at: columnasDelCaso.updated_at,
          real: esCasoReal,
        })
        .from(cases)
        .where(eq(cases.id, caseId))
        .limit(1),
      db
        .select({ field_key: extractedFields.field_key, field_value: extractedFields.field_value })
        .from(extractedFields)
        .where(eq(extractedFields.case_id, caseId)),
      ...(mock ? [] : [consultaDeLaConfig(db)]),
    ]);
  } catch (e) {
    if (esFaltaDe0036(e)) return sinConfigurar(caseId, "sin_configurar");
    throw e;
  }
  const [caseRow] = filas[0] as Array<CasoParaElCore & { status: typeof cases.$inferSelect.status; real: boolean }>;
  const fieldRows = filas[1] as Array<{ field_key: string; field_value: string }>;
  const [filaConfig] = mock ? [] : (filas[2] as FilaDeCoreSync[]);

  if (!caseRow) return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));

  const currentStatus = caseRow.status;
  const tenantId = caseRow.tenant_id;

  // ── 6. FSM precondition ───────────────────────────────────────────────────────
  // `force` es el reintento desde `error_core`, nada más. Desde otro estado
  // mandaría al Core un caso ya enviado, cerrado o en liquidación.
  const origenes: readonly string[] = force ? [REQUIRED_STATUS, FAILURE_STATUS] : [REQUIRED_STATUS];
  if (!origenes.includes(currentStatus)) {
    return err(
      new AppError(
        "FSM_INVALID_TRANSITION",
        force && currentStatus === SUCCESS_STATUS
          ? "El caso ya fue enviado al Core."
          : `El caso debe estar en estado '${REQUIRED_STATUS}'. Estado actual: '${currentStatus}'.`
      )
    );
  }

  // ── 7. Call CoreSyncClient ────────────────────────────────────────────────────
  /*
   * Si no hay cliente, no se toca el caso.
   *
   * Antes esto no podía pasar porque la fábrica devolvía el simulador siempre,
   * y por eso un caso terminaba en `enviado_a_core` con un
   * `core_external_id` inventado. El 501 sale ANTES de cualquier escritura: ni
   * estado, ni identificador, ni fila de auditoría diciendo que se envió.
   */
  let syncClient;
  try {
    syncClient = getCoreSyncClient(filaConfig ?? null);
  } catch (e) {
    if (e instanceof CoreSyncSinConfigurar) return sinConfigurar(caseId, e.modo);
    throw e;
  }

  // Lo mismo que /api/v1: un caso simulado o de prueba no llega al sistema real.
  // El mock (demo y tests) sí los manda: sus casos son todos simulados.
  if (!mock && !caseRow.real) {
    logger.warn({ case_id: caseId }, "core_sync.caso_de_prueba");
    return err(new AppError("NOT_IMPLEMENTED", "Los casos simulados o de prueba no se envían al sistema central."));
  }

  const payload = armarPayload(caseRow, fieldRows);
  const result = await syncClient.syncCase(payload);
  const now = new Date().toISOString();

  if (result.ok) {
    const [quedo] = await enTenant(tenantCtx, (db) =>
      db.update(cases)
        .set({ status: SUCCESS_STATUS, core_external_id: result.externalId, core_sent_at: now, updated_at: now })
        // También desde `error_core`: si otro envío falló antes, el 2xx de este gana.
        .where(and(eq(cases.id, caseId), inArray(cases.status, [REQUIRED_STATUS, FAILURE_STATUS])))
        .returning({ id: cases.id })
    );

    if (!quedo) {
      // El Core ya recibió el caso; lo que se perdió es el estado local, no el
      // envío. Se audita igual — con el id externo — para no perder el rastro.
      logger.warn({ case_id: caseId, seen: currentStatus, core_external_id: result.externalId }, "core_sync.status_not_applied");
      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: userRow.id,
        event_type: AuditEvent.CORE_SYNC_SUCCESS,
        target_type: "case",
        target_id: caseId,
        payload: { case_id: caseId, core_external_id: result.externalId, from_status: currentStatus, new_status: SUCCESS_STATUS, status_not_applied: true },
      });
      return err(new AppError("FSM_INVALID_TRANSITION", "El caso cambió mientras se enviaba; el envío al Core quedó registrado en la auditoría."));
    }

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userRow.id,
      event_type: AuditEvent.CORE_SYNC_SUCCESS,
      target_type: "case",
      target_id: caseId,
      payload: { case_id: caseId, core_external_id: result.externalId, from_status: currentStatus, new_status: SUCCESS_STATUS },
    });

    return ok({ synced: true, externalId: result.externalId });
  } else {
    // Un código fijo (timeout, http_502…), nunca texto del Core.
    const errorMessage = result.motivo;

    const [quedo] = await enTenant(tenantCtx, (db) =>
      db.update(cases)
        .set({ status: FAILURE_STATUS, core_error_message: errorMessage, updated_at: now })
        .where(and(eq(cases.id, caseId), eq(cases.status, currentStatus)))
        .returning({ id: cases.id })
    );

    if (!quedo) {
      // No hay nada que deshacer: el envío ya falló solo. Sólo queda avisar
      // que el estado local no se pudo escribir.
      logger.warn({ case_id: caseId, seen: currentStatus }, "core_sync.status_not_applied");
      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: userRow.id,
        event_type: AuditEvent.CORE_SYNC_FAILED,
        target_type: "case",
        target_id: caseId,
        payload: { case_id: caseId, error_code: "CORE_SYNC_FAILED", motivo: errorMessage, from_status: currentStatus, new_status: FAILURE_STATUS, status_not_applied: true },
      });
      return ok({ synced: false, errorMessage });
    }

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: userRow.id,
      event_type: AuditEvent.CORE_SYNC_FAILED,
      target_type: "case",
      target_id: caseId,
      payload: { case_id: caseId, error_code: "CORE_SYNC_FAILED", motivo: errorMessage, from_status: currentStatus, new_status: FAILURE_STATUS },
    });

    return ok({ synced: false, errorMessage });
  }
}
