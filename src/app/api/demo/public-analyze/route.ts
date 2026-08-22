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
import { checkDemoBudget, getDemoTenantId } from "@/server/ai/budget";
import { rateLimit, getClientIp } from "@/lib/rate-limit/index";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";

export const maxDuration = 60;

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

  /*
   * El techo duro del endpoint anónimo.
   *
   * El límite por IP se puede esquivar rotando IPs, que cuesta centavos, así
   * que el presupuesto es lo que de verdad acota el abuso. Lo que importa es
   * de quién es ese presupuesto: hasta ahora era el del tenant de producción,
   * y el tope mensual ni siquiera filtraba por tenant. Un anónimo agotaba
   * cualquiera de los dos y a partir de ahí ninguna denuncia real se extraía,
   * sin que fallara nada en voz alta.
   *
   * Ahora la demo tiene tenant propio y tope propio. Sin DEMO_TENANT_ID no
   * atiende: pedir prestado el presupuesto de producción es justamente lo que
   * se está arreglando.
   */
  const demoTenantId = getDemoTenantId();
  if (!demoTenantId) {
    return err(new AppError("RATE_LIMITED", "La demo no está disponible en este momento."));
  }

  const budget = await checkDemoBudget();
  if (budget.exceeded) {
    return err(new AppError("RATE_LIMITED", "La demo alcanzó su cupo diario. Volvé mañana."));
  }

  let result;
  try {
    result = await extractEmailClaimGemini(
      { subject: parsed.data.subject, body: parsed.data.body, memoryHints: [], knownPatterns: [] },
      demoTenantId,
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
