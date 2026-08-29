/**
 * POST /api/intake/simulate — simulate an inbound email claim.
 *
 * AC4: Returns 202 immediately with {case_id, status: "procesando"}.
 *       Creates case + raw_messages row. Triggers AI extraction worker async.
 * LLM10 (budget guard): Returns 429 with code AI_BUDGET_EXCEEDED when any budget
 *       cap (per-user, per-tenant, or monthly) is exceeded. Fail-closed per spec.
 * AC17: LLM prompt injection contained via XML sentinels in prompt.ts.
 *
 * Rate limit: 30/min per user (INTAKE_SIMULATE config).
 * Auth: cualquier rol que pueda tocar un caso — o sea, todos menos `viewer`.
 *
 * Body modes:
 *   { scenario_id: "choque-01" }          → use pre-seeded scenario
 *   { raw_text: "...", case_type: "robo" } → ad-hoc text
 */

import { type NextRequest, after } from "next/server";
import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { cases, rawMessages } from "@/lib/db/schema";
import {
  requireRole,
  CASE_EDITOR_ROLES,
  type RoleContext,
} from "@/lib/auth/require-role";
import { SimulateIntakeSchema } from "@/lib/schemas/intake";
import { getScenarioById } from "@/server/intake/scenarios";
import { runIntakeAgent } from "@/server/agents/intake-agent";
import { checkBudget } from "@/server/ai/budget";
import { reapStuckProcessingCases } from "@/server/intake/reap-stuck";
import { remitenteDeEnsayo } from "@/server/intake/remitente-de-ensayo";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { accepted, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
  getClientIp,
} from "@/lib/rate-limit/index";
import type { ClaimType } from "@/lib/schemas/cases";
import { enTenant } from "@/data/scope";
import { start } from "workflow/api";
import { procesarCasoSimulado } from "@/workflows/intake-simulado";

export const maxDuration = 180;

function scheduleAfterResponse(task: () => Promise<void>): void {
  try {
    after(task);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    const code = (err as { __NEXT_ERROR_CODE?: string })?.__NEXT_ERROR_CODE;
    if (code === "E468" || message.includes("outside a request scope")) {
      void task();
      return;
    }
    throw err;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  /*
   * ── 1. Sesión y rol ───────────────────────────────────────────────────────
   *
   * El encabezado de este archivo decía «Auth: required (analyst or admin
   * role)» y la guarda de rol no existía: se comprobaba que hubiera sesión y
   * que existiera la fila de perfil, y nunca se miraba `role`.
   *
   * O sea que un `viewer` —el rol de sólo lectura— creaba un caso REAL en la
   * base de su aseguradora, disparaba la extracción con el proveedor de IA
   * (costo real) y sumaba al contador de casos facturables. Era la única puerta
   * de escritura abierta al rol de sólo lectura: todas las hermanas que tocan
   * un caso lo bloquean explícitamente.
   *
   * Lo peor era que estaba documentado. Quien revisara el archivo leía que la
   * guarda estaba.
   */
  let ctx: RoleContext;
  try {
    ctx = await requireRole(...CASE_EDITOR_ROLES);
  } catch (e) {
    return err(e instanceof AppError ? e : new AppError("INTERNAL_ERROR"));
  }
  const { userRow } = ctx;

  // ── 2. Rate limit ────────────────────────────────────────────────────────────
  const ip = getClientIp(request);
  const rlKey = buildUserKey(userRow.id, "intake-simulate");
  const rlResult = await rateLimit(rlKey, RATE_LIMIT_CONFIGS.INTAKE_SIMULATE);

  if (!rlResult.allowed) {
    // El `Retry-After` es la razón por la que esto se armaba a mano: `err()`
    // no sabía poner encabezados. Ahora sí, y el cuerpo lo arma el mismo lugar
    // que el del resto del producto.
    return err(new AppError("RATE_LIMITED"), undefined, {
      "Retry-After": String(rlResult.retryAfterSeconds),
    });
  }

  // ── 3. Validate body ─────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err(new AppError("VALIDATION_FAILED", "El cuerpo de la solicitud no es JSON válido."));
  }

  const parsed = SimulateIntakeSchema.safeParse(body);
  if (!parsed.success) {
    return err(
      new AppError(
        "VALIDATION_FAILED",
        parsed.error.issues[0]?.message ?? "Datos de entrada inválidos.",
        parsed.error.flatten()
      )
    );
  }

  const input = parsed.data;

  // ── 4. Resolve scenario or raw text ─────────────────────────────────────────
  let rawText: string;
  let claimType: ClaimType;
  let policyholderName: string | null = null;
  let policyNumber: string | null = null;

  if (input.scenario_id) {
    const scenario = getScenarioById(input.scenario_id);
    if (!scenario) {
      return err(
        new AppError(
          "VALIDATION_FAILED",
          `ID de escenario inválido: ${input.scenario_id}.`
        )
      );
    }
    rawText = scenario.raw_text;
    claimType = scenario.case_type;
    policyholderName = scenario.policyholder_name;
    policyNumber = scenario.policy_number;
  } else {
    rawText = input.raw_text!;
    claimType = input.case_type!;
  }

  // ── 5. Budget guard ──────────────────────────────────────────────────────────
  const budgetResult = await checkBudget(userRow.tenant_id, userRow.id);
  if (budgetResult.exceeded) {
    await writeAuditLog({
      tenant_id: userRow.tenant_id,
      actor_id: userRow.id,
      event_type: AuditEvent.AI_BUDGET_EXCEEDED,
      target_type: null,
      target_id: null,
      payload: { reason: budgetResult.reason },
      ip,
      ua: request.headers.get("user-agent") ?? undefined,
    });
    /*
     * El mensaje sale del motivo, y no de una suposición.
     *
     * Decía «Presupuesto de IA agotado para este mes» pase lo que pase, pero de
     * los tres topes que mira `checkBudget` sólo uno es mensual: los otros dos
     * son diarios, por inquilino y por usuario. O sea que dos de cada tres
     * veces le decía a alguien que esperara al mes siguiente cuando en realidad
     * al día siguiente podía seguir.
     *
     * `reason` ya viene armado con cuál se agotó y cuánto: se usa ése.
     */
    return err(
      new AppError("AI_BUDGET_EXCEEDED", budgetResult.reason, {
        reason: budgetResult.reason,
      })
    );
  }

  // Opportunistically clear cases stuck in `procesando` from an earlier batch
  // whose after() callbacks were evicted, so they don't crowd the throttle.
  try {
    await reapStuckProcessingCases({ tenantId: userRow.tenant_id });
  } catch {
    // never block a new simulation on reaper failure
  }

  // ── 6. Create case + raw_message in DB ───────────────────────────────────────
  let caseId: string;
  let caseCreatedAt: string | null = null;
  try {
    const newCase = firstRow(
      await enTenant({ tenantId: userRow.tenant_id }, (db) =>
        db
          .insert(cases)
          .values({
            tenant_id: userRow.tenant_id,
            policy_number: policyNumber,
            policyholder_name: policyholderName,
            claim_type: claimType,
            status: "procesando",
            confidence_min: null,
            assigned_to: userRow.id,
            channel: "email_sim",
          })
          .returning({ id: cases.id, created_at: cases.created_at })
      )
    );
    if (!newCase) {
      console.error("[intake/simulate] Failed to create case: no_row");
      return err(new AppError("INTERNAL_ERROR"));
    }
    caseId = newCase.id;
    caseCreatedAt = newCase.created_at ?? null;
  } catch (e) {
    const code = (e as { code?: string })?.code;
    console.error("[intake/simulate] Failed to create case:", code);
    return err(new AppError("INTERNAL_ERROR"));
  }

  // Create raw_message row (stores full email body verbatim — PII stored, never logged).
  try {
    await enTenant({ tenantId: userRow.tenant_id }, (db) =>
      db.insert(rawMessages).values({
        case_id: caseId,
        tenant_id: userRow.tenant_id,
        channel: "email_sim",
        from_addr: remitenteDeEnsayo(policyholderName),
        subject: `[email_sim] Siniestro - ${claimType} - ${input.scenario_id ?? "custom"}`,
        body: rawText,
      })
    );
  } catch (e) {
    const code = (e as { code?: string })?.code;
    console.error("[intake/simulate] Failed to create raw_message:", code);
    // Non-fatal — case still created; worker will fail gracefully.
  }

  // Audit log: case created.
  await writeAuditLog({
    tenant_id: userRow.tenant_id,
    actor_id: userRow.id,
    event_type: AuditEvent.CASE_CREATED,
    target_type: "case",
    target_id: caseId,
    payload: {
      claim_type: claimType,
      channel: "email_sim",
      scenario_id: input.scenario_id ?? null,
    },
    ip,
    ua: request.headers.get("user-agent") ?? undefined,
  });

  // ── 7. Arrancar el flujo durable ────────────────────────────────────────────
  //
  // Esto ya no es un `after()`. `after()` mantiene viva ESTA invocación hasta
  // que el trabajo termina, y cuando hay muchos casos encolados Vercel descarta
  // los que no alcanzaron a arrancar: el caso queda en `procesando` para
  // siempre. El barrido de `reap-stuck.ts` existe por eso.
  //
  // `start()` encola el flujo y vuelve. El trabajo corre en sus propias
  // peticiones, y si el proceso muere retoma en el paso que seguía.
  try {
    await start(procesarCasoSimulado, [
      { caseId, tenantId: userRow.tenant_id, userId: userRow.id, caseCreatedAt },
    ]);
  } catch (e: unknown) {
    // Si no se pudo encolar, se cae al camino de antes en vez de dejar el caso
    // colgado. Un flujo que no arranca es peor que un `after()` que quizás sí.
    const name = e instanceof Error ? e.name : "UnknownError";
    console.error("[intake/simulate] no pude encolar el flujo:", name, "caso:", caseId);
    scheduleAfterResponse(async () => {
      try {
        await runIntakeAgent({
          caseId,
          tenantId: userRow.tenant_id,
          userId: userRow.id,
          source: "simulate",
        });
      } catch (e2: unknown) {
        const n = e2 instanceof Error ? e2.name : "UnknownError";
        console.error("[intake/simulate] Worker error:", n, "case:", caseId);
      }
    });
  }

  // ── 8. Return 202 immediately ─────────────────────────────────────────────────
  return accepted({
    case_id: caseId,
    status: "procesando",
    message: "Procesando...",
  });
}
