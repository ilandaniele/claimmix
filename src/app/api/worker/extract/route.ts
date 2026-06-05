/**
 * POST /api/worker/extract — internal worker trigger endpoint.
 *
 * Accepts a JSON body with { caseId, tenantId } and runs the bounded intake
 * agent for the specified case. Used as a fire-and-forget endpoint from webhook
 * handlers (or Vercel cron) to decouple extraction from webhook response latency.
 *
 * Auth: Internal-only. Accepts either:
 *   a) X-Internal-Worker: true header (same-origin worker call)
 *   b) Authorization: Bearer <CRON_SECRET> header (Vercel cron / scheduled triggers)
 *
 * This endpoint is NOT user-facing — it should not be exposed publicly.
 * The proxy.ts (middleware) will block unauthenticated requests to /api/worker/*
 * so this header check is defense-in-depth.
 *
 * Returns 200 on success, 500 on error (for fire-and-forget callers).
 *
 * W3: AC5, AC6, AC8, AC11, AC15, AC22.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runIntakeAgent } from "@/server/agents/intake-agent";

const WorkerBodySchema = z.object({
  caseId: z.string().uuid("caseId must be a valid UUID."),
  tenantId: z.string().uuid("tenantId must be a valid UUID."),
});

/**
 * Verify the caller is an internal worker or Vercel cron.
 * Returns true if the request is authorized.
 */
function isAuthorized(request: NextRequest): boolean {
  // Option A: same-origin internal worker header.
  const internalHeader = request.headers.get("x-internal-worker");
  if (internalHeader === "true") return true;

  // Option B: Vercel cron secret.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader === `Bearer ${cronSecret}`) return true;
  }

  return false;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── Auth check ────────────────────────────────────────────────────────────────
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Acceso no autorizado al worker." } },
      { status: 401 }
    );
  }

  // ── Parse body ────────────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_PAYLOAD", message: "El cuerpo de la solicitud no es JSON válido." } },
      { status: 400 }
    );
  }

  const parsed = WorkerBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Parámetros inválidos.",
          details: parsed.error.flatten(),
        },
      },
      { status: 400 }
    );
  }

  const { caseId, tenantId } = parsed.data;

  // ── Run worker ────────────────────────────────────────────────────────────────
  try {
    const result = await runIntakeAgent({ caseId, tenantId, source: "worker" });
    return NextResponse.json({ ok: true, case_id: caseId, agent: result }, { status: 200 });
  } catch (err) {
    const errName = err instanceof Error ? err.name : "UnknownError";
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "worker_route.unhandled_error",
        case_id: caseId,
        error_name: errName,
      })
    );
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Error en el worker de extracción." } },
      { status: 500 }
    );
  }
}
