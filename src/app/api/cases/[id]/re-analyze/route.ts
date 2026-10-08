/**
 * POST /api/cases/:id/re-analyze — re-run AI extraction worker on a case.
 *
 * Rate limit: 5/hr/case (to prevent cost abuse from re-triggering).
 * Auth: required (analyst or admin).
 *
 * FSM: Case must be in a non-terminal, non-procesando state to allow re-analysis.
 *      Re-analysis temporarily sets status to "procesando" then the worker transitions it.
 *
 * LLM10: Budget check before running extractor.
 * Every query filters explicitly by the caller's tenant_id (enTenant, backed by RLS).
 */

import { type NextRequest, after } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { ALL_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { ADMIN_ROLES, puedeCambiarEstado } from "@/lib/auth/roles";
import { entrar } from "@/lib/api/entrada";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { cases } from "@/lib/db/schema";
import { CaseStatusSchema, type CaseStatus } from "@/lib/schemas/cases";
import { runIntakeAgent } from "@/server/agents/intake-agent";
import { checkBudget } from "@/server/ai/budget";
import { ESTADOS_QUE_NO_SE_REABREN_A_MANO } from "@/core/case/fsm";
import { reservaViva } from "@/core/case/reserva-de-extraccion";
import { writeAuditLog } from "@/lib/audit/log";
import { accepted, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import {
  getClientIp,
  type RateLimitResult,
} from "@/lib/rate-limit/index";

export const maxDuration = 300;

const ParamsSchema = z.object({
  id: z.string().uuid("ID de caso inválido."),
});

// «Marcar como relevante» es un re-análisis de un descartado que además fija `is_claim`.
// El cuerpo es opcional: sin él, la ruta se comporta como siempre.
const BodySchema = z.object({ marcar_relevante: z.literal(true).optional() });

// Rate limit: 5 re-analyses per hour per case.
const RE_ANALYZE_LIMIT = { limit: 5, windowMs: 3_600_000 };

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const rawParams = await context.params;
  const paramsParsed = ParamsSchema.safeParse(rawParams);
  if (!paramsParsed.success) {
    return err(new AppError("VALIDATION_FAILED", paramsParsed.error.issues[0]?.message));
  }
  const caseId = paramsParsed.data.id;

  // ── Quién sos, qué podés y cuánto venís pidiendo — en un solo viaje ─────────
  //
  // El cupo de acá es POR CASO, no por usuario: cinco re-análisis por hora sobre
  // el mismo siniestro. Por eso la clave es por caso y usuario, no el `user:` de siempre.
  let ctx: RoleContext;
  let rlResult: RateLimitResult;
  try {
    ({ ctx, rl: rlResult } = await entrar(
      (userId) => claveDeCupo("re-analyze", caseId, userId),
      RE_ANALYZE_LIMIT,
      ...ALL_ROLES
    ));
  } catch {
    return err(new AppError("MISSING_SESSION"));
  }
  const { userRow } = ctx;
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  // Este contexto es lo único que le dice de quién son los datos.
  const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };

  // Viewers are read-only.
  if (userRow.role === "viewer") {
    return err(new AppError("FORBIDDEN_ROLE", "Tu rol es de solo lectura."));
  }

  const ip = getClientIp(request);

  if (!rlResult.allowed) {
    return new Response(
      JSON.stringify({
        error: { code: "RATE_LIMITED", message: "Demasiados re-análisis para este caso. Esperá una hora." },
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(rlResult.retryAfterSeconds) },
      }
    );
  }

  const bodyParsed = BodySchema.safeParse((await request.json().catch(() => null)) ?? {});
  if (!bodyParsed.success) {
    return err(new AppError("VALIDATION_FAILED", "Cuerpo inválido."));
  }
  const marcarRelevante = bodyParsed.data.marcar_relevante === true;

  // ── Verify case belongs to tenant (IDOR — explicit tenant_id filter) ─────────
  let caseRow: {
    id: string;
    status: string;
    assigned_to: string | null;
    extraction_lease_at: string | null;
    extraction_pending: boolean;
  } | null;
  try {
    caseRow = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({
            id: cases.id,
            status: cases.status,
            assigned_to: cases.assigned_to,
            extraction_lease_at: cases.extraction_lease_at,
            extraction_pending: cases.extraction_pending,
          })
          .from(cases)
          .where(eq(cases.id, caseId))
          .limit(1)
      )
    );
  } catch {
    caseRow = null;
  }

  if (!caseRow) return err(new AppError("NOT_FOUND"));

  // E3: un analyst re-analiza sólo un caso suyo o sin asignar — misma regla que el PATCH.
  if (!puedeCambiarEstado(userRow, caseRow.assigned_to)) {
    return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
  }

  const statusParsed = CaseStatusSchema.safeParse(caseRow.status);
  /*
   * `ESTADOS_QUE_NO_SE_REABREN_A_MANO` y no `isTerminalStatus`.
   *
   * Esta guarda expresa una regla de PERMISOS —un analista común no reabre un
   * caso cerrado— y se apoyaba en la pregunta estructural «¿es terminal?». El
   * día que `no_relevante` dejó de ser terminal del todo (tiene una salida: la
   * que toma el camino de ingreso cuando llega un mensaje), la guarda se
   * evaporó sola y cualquier analista pasó a poder re-analizarlo.
   */
  if (statusParsed.success && ESTADOS_QUE_NO_SE_REABREN_A_MANO.has(statusParsed.data)) {
    // Admins can re-analyze cases stuck in no_relevante due to provider errors.
    // Regular analysts cannot re-open terminal cases.
    const isAdmin = (ADMIN_ROLES as readonly string[]).includes(userRow.role);
    const isNoRelevante = statusParsed.data === "no_relevante";
    if (!isAdmin || !isNoRelevante) {
      return err(
        new AppError(
          "FSM_INVALID_TRANSITION",
          "No se puede re-analizar un caso en estado terminal. Los administradores pueden re-analizar casos 'no_relevante' atascados por errores técnicos."
        )
      );
    }
  }

  if (marcarRelevante && caseRow.status !== "no_relevante") {
    return err(new AppError("FSM_INVALID_TRANSITION", "Sólo se marca como relevante un caso descartado."));
  }

  // Un caso ya enviado a Core no vuelve a `procesando`: eso lo desengancharía
  // del envío que ya se hizo. Sólo `sync-to-core` escribe/lee esa transición.
  if (statusParsed.success && statusParsed.data === "enviado_a_core") {
    return err(
      new AppError("FSM_INVALID_TRANSITION", "El caso ya se envió a Core. No se puede re-analizar.")
    );
  }

  // E4: no se re-analiza un caso mientras el agente sigue trabajando en él.
  if (caseRow.extraction_pending || reservaViva(caseRow.extraction_lease_at, new Date())) {
    return err(new AppError("FSM_INVALID_TRANSITION", "El agente está trabajando en este caso."));
  }

  // ── Budget check ──────────────────────────────────────────────────────────────
  const budgetResult = await checkBudget(userRow.tenant_id, userRow.id);
  if (budgetResult.exceeded) {
    return err(new AppError("AI_BUDGET_EXCEEDED", "Presupuesto de IA agotado para este mes."));
  }

  // ── Reset case to procesando ──────────────────────────────────────────────────
  // El where exige además el status que vimos al leer: si cambió en el medio
  // (TOCTOU), el update no matchea ninguna fila.
  try {
    const resetCase = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
        .update(cases)
        .set({
          status: "procesando",
          updated_at: new Date().toISOString(),
          // Con `is_claim` en true el clasificador no lo vuelve a descartar (extract.ts, «ignored_unclaim»).
          ...(marcarRelevante ? { is_claim: true } : {}),
        })
          .where(and(eq(cases.id, caseId), eq(cases.status, caseRow.status as CaseStatus)))
          .returning({ id: cases.id, status: cases.status })
      )
    );
    if (!resetCase) {
      return err(
        new AppError("FSM_INVALID_TRANSITION", "El caso cambió mientras lo mirabas.")
      );
    }
  } catch (e) {
    logger.error({ code: errorCode(e), case_id: caseId }, "re_analyze.failed_to_reset_case");
    return err(new AppError("INTERNAL_ERROR"));
  }

  await writeAuditLog({
    tenant_id: userRow.tenant_id,
    actor_id: userRow.id,
    event_type: "case.re_analyze_triggered",
    target_type: "case",
    target_id: caseId,
    payload: { previous_status: caseRow.status, ...(marcarRelevante ? { reason: "marcado_relevante" } : {}) },
    ip,
    ua: request.headers.get("user-agent") ?? undefined,
  });

  // ── Trigger worker after response is sent ────────────────────────────────────
  // Using after() ensures Vercel keeps the function alive until the worker
  // finishes — plain fire-and-forget gets killed when the 202 is returned.
  after(async () => {
    try {
      await runIntakeAgent({
        caseId,
        tenantId: userRow.tenant_id,
        userId: userRow.id,
        source: "manual",
      });
    } catch (e: unknown) {
      const name = e instanceof Error ? e.name : "UnknownError";
      logger.error({ error_name: name, case_id: caseId }, "re_analyze.worker_error");
    }
  });

  return accepted({ case_id: caseId, status: "procesando", message: "Re-análisis iniciado." });
}
