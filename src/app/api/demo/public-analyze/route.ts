/**
 * POST /api/demo/public-analyze — public Gemini extraction for the prospect demo screen.
 *
 * No auth required. Rate-limited by IP (5 requests per hour per IP).
 * No DB case created — extraction result returned directly.
 */

import "server-only";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { extractEmailClaimGemini } from "@/server/ai/gemini-extractor";
import { checkBudget } from "@/server/ai/budget";
import { rateLimit, getClientIp } from "@/lib/rate-limit/index";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";

export const maxDuration = 60;

const DEMO_TENANT_ID = "10000000-0000-0000-0000-000000000001";
const DEMO_USER_ID = "demo-public";

const AnalyzeSchema = z.object({
  subject: z.string().min(1).max(500),
  body: z.string().min(10).max(20_000),
});

export async function POST(request: NextRequest): Promise<Response> {
  const ip = getClientIp(request);
  const rl = await rateLimit(`demo-public:${ip}`, { limit: 5, windowMs: 3_600_000 });
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({
        error: { code: "RATE_LIMITED", message: "Demasiadas solicitudes. Volvé en un rato." },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(rl.retryAfterSeconds),
        },
      }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err(new AppError("VALIDATION_FAILED", "JSON inválido."));
  }

  const parsed = AnalyzeSchema.safeParse(body);
  if (!parsed.success) {
    return err(new AppError("VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Datos inválidos."));
  }

  // Hard cost ceiling for the anonymous endpoint: the in-memory IP limiter is
  // per-instance on serverless, so the tenant daily-token / monthly-cost budget
  // is the backstop that actually bounds abuse spend.
  const budget = await checkBudget(DEMO_TENANT_ID, null);
  if (budget.exceeded) {
    return err(new AppError("RATE_LIMITED", "La demo alcanzó su cupo diario. Volvé mañana."));
  }

  let result;
  try {
    result = await extractEmailClaimGemini(
      { subject: parsed.data.subject, body: parsed.data.body, memoryHints: [], knownPatterns: [] },
      DEMO_TENANT_ID,
      "demo",
      DEMO_USER_ID
    );
  } catch (e) {
    // Log detail server-side; never echo provider internals (quota state, model
    // names, key hints) to anonymous callers.
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "demo.public_analyze.provider_error",
        error_name: e instanceof Error ? e.name : "UnknownError",
      })
    );
    return err(new AppError("INTERNAL_ERROR", "No pudimos analizar el reclamo en este momento. Probá de nuevo en unos minutos."));
  }

  return ok(result);
}
