/**
 * POST /api/worker/extract — internal worker trigger endpoint.
 *
 * Accepts a JSON body with { caseId, tenantId } and runs the bounded intake
 * agent for the specified case. Used as a fire-and-forget endpoint from webhook
 * handlers (or Vercel cron) to decouple extraction from webhook response latency.
 *
 * Auth: interna, con CRON_SECRET (Bearer). NO es una ruta de cara al usuario.
 * El header `X-Internal-Worker: true` que aceptaba antes lo puede mandar
 * cualquiera; proxy.ts no corre sobre /api, así que no había segunda capa que
 * lo tapara. Ver internal-auth.ts.
 *
 * Returns 200 on success, 500 on error (for fire-and-forget callers).
 *
 * W3: AC5, AC6, AC8, AC11, AC15, AC22.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runIntakeAgent } from "@/server/agents/intake-agent";
import { isInternalRequest } from "@/lib/security/internal-auth";

const WorkerBodySchema = z.object({
  caseId: z.string().uuid("caseId must be a valid UUID."),
  tenantId: z.string().uuid("tenantId must be a valid UUID."),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── Auth check ────────────────────────────────────────────────────────────────
  // Antes bastaba `X-Internal-Worker: true`, un header que manda cualquiera, y
  // encima el CRON_SECRET se comparaba con === (oráculo de timing). Ahora los
  // dos caminos son uno: el secreto, en tiempo constante. Ver internal-auth.ts.
  if (!isInternalRequest(request)) {
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
