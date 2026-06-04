/**
 * POST /api/admin/reprocess-unclassified — trigger extraction for unclassified cases.
 *
 * Selects up to 50 email cases where severity OR claim_type is NULL and the case
 * is in an open status, then dispatches /api/worker/extract for each one.
 *
 * Auth: Internal-only. Same pattern as /api/worker/extract.
 *   a) X-Internal-Worker: true header (same-origin worker call)
 *   b) Authorization: Bearer <CRON_SECRET> header (Vercel cron / scheduled triggers)
 *
 * Response shape (always 200 on partial or full success):
 *   { data: { triggered: number, case_ids: string[], failed: string[] } }
 *
 * AC12: 401 without internal-auth header.
 * AC13: selects up to 50 unclassified cases, triggers /api/worker/extract for each.
 * AC14: empty result set → 200 { triggered: 0, case_ids: [], failed: [] }.
 * AC15: per-case dispatch failure isolated → failed[] populated, others still triggered.
 */

import { type NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getWorkerBaseUrl } from "@/server/email/dispatch-url";

/** Statuses considered "open" for reprocessing. */
const OPEN_STATUSES = ["recibido", "listo", "info_faltante"] as const;

/** Max cases dispatched per call. */
const BATCH_LIMIT = 50;

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

interface UnclassifiedCase {
  id: string;
  tenant_id: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── Auth check ────────────────────────────────────────────────────────────────
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Acceso no autorizado." } },
      { status: 401 }
    );
  }

  // ── Query unclassified cases ──────────────────────────────────────────────────
  const supabase = createServiceClient();

  const { data: cases, error: queryError } = await (supabase as any)
    .from("cases")
    .select("id, tenant_id")
    .eq("channel", "email")
    .in("status", OPEN_STATUSES)
    .or("severity.is.null,claim_type.is.null")
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT) as {
      data: UnclassifiedCase[] | null;
      error: { code: string; message: string } | null;
    };

  if (queryError) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "reprocess_unclassified.query_error",
        error_code: queryError.code,
      })
    );
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Error al consultar casos." } },
      { status: 500 }
    );
  }

  // ── Empty result — return early ───────────────────────────────────────────────
  if (!cases || cases.length === 0) {
    return NextResponse.json(
      { data: { triggered: 0, case_ids: [], failed: [] } },
      { status: 200 }
    );
  }

  // ── Dispatch /api/worker/extract for each case ────────────────────────────────
  const workerUrl = `${getWorkerBaseUrl()}/api/worker/extract`;
  const caseIds: string[] = [];
  const failed: string[] = [];

  await Promise.all(
    cases.map(async (caseRow) => {
      try {
        const response = await fetch(workerUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Worker": "true",
          },
          body: JSON.stringify({
            caseId: caseRow.id,
            tenantId: caseRow.tenant_id,
          }),
        });

        if (!response.ok) {
          // Non-2xx responses are treated as dispatch failures.
          console.error(
            JSON.stringify({
              level: "warn",
              service: "claimmix",
              msg: "reprocess_unclassified.dispatch_failed",
              case_id: caseRow.id,
              http_status: response.status,
            })
          );
          failed.push(caseRow.id);
        } else {
          caseIds.push(caseRow.id);
        }
      } catch (err) {
        // Network / fetch-level failure — isolate, do not crash the batch.
        const errName = err instanceof Error ? err.name : "UnknownError";
        console.error(
          JSON.stringify({
            level: "error",
            service: "claimmix",
            msg: "reprocess_unclassified.dispatch_error",
            case_id: caseRow.id,
            error_name: errName,
          })
        );
        failed.push(caseRow.id);
      }
    })
  );

  return NextResponse.json(
    {
      data: {
        triggered: caseIds.length,
        case_ids: caseIds,
        failed,
      },
    },
    { status: 200 }
  );
}
