/**
 * GET /api/cases/export.csv — CSV export of the filtered case view.
 *
 * AC13: Returns text/csv with Content-Disposition attachment.
 *       Formula-injection-safe values (=, +, -, @ prefixed with single quote).
 *       Max 1000 rows per export.
 *       Same explicit tenant_id isolation as GET /api/cases (RLS is gone).
 *
 * Columns: Nro. Siniestro, Asegurado, Póliza, Tipo, Estado, Confianza, Fecha, Analista.
 * Filters: same query params as GET /api/cases (status, type, q).
 *
 * Rate limit: 100 req/min per user (CASES_API config — export is heavier but same bucket).
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireRole, ALL_ROLES, type RoleContext } from "@/lib/auth/require-role";
import { CaseQuerySchema } from "@/lib/schemas/cases";
import { listCasesForExport } from "@/server/cases/list";
import { buildCsv } from "@/lib/csv/safe-encode";
import { err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
  getClientIp,
} from "@/lib/rate-limit/index";

/** CSV column headers (es-AR labels as specified in AC13) */
const CSV_HEADERS = [
  "Nro. Siniestro",
  "Asegurado",
  "Póliza",
  "Tipo",
  "Estado",
  "Confianza",
  "Fecha",
  "Analista",
];

/** Claim type Spanish labels */
const CLAIM_TYPE_LABELS: Record<string, string> = {
  choque: "Choque",
  robo: "Robo",
  granizo: "Granizo",
  incendio: "Incendio",
};

/** Status Spanish labels */
const STATUS_LABELS: Record<string, string> = {
  procesando: "Procesando",
  listo: "Listo",
  esperando: "Esperando",
  escalado: "Escalado",
  cerrado: "Cerrado",
};

/** Format ISO date string as DD/MM/YYYY for es-AR locale */
function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** Format confidence score as percentage string */
function formatConfidence(score: number | null): string {
  if (score === null || score === undefined) return "";
  return `${Math.round(score * 100)}%`;
}

export async function GET(request: NextRequest) {
  // ── 1. Auth ───────────────────────────────────────────────────────────────
  let ctx: RoleContext;
  try {
    ctx = await requireRole(...ALL_ROLES);
  } catch (e) {
    return err(e instanceof AppError ? e : new AppError("INTERNAL_ERROR"));
  }
  const { user, userRow } = ctx;

  // ── 2. Rate limit ─────────────────────────────────────────────────────────
  const ip = getClientIp(request);
  const rlKey = buildUserKey(user.id, "cases-export");
  const rl = await rateLimit(rlKey, RATE_LIMIT_CONFIGS.CASES_API);
  if (!rl.allowed) {
    return err(new AppError("RATE_LIMITED", "Demasiadas solicitudes."));
  }

  // ── 3. Parse query params (same schema as list, but page/per_page ignored) ─
  const searchParams = request.nextUrl.searchParams;
  const rawQuery = {
    status: searchParams.get("status") ?? undefined,
    type: searchParams.get("type") ?? undefined,
    q: searchParams.get("q") ?? undefined,
    // page/per_page/sort/order are ignored for export (always max 1000, date desc)
    page: "1",
    per_page: "100",
    sort: "created_at",
    order: "desc",
  };

  const parsed = CaseQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    return err(
      new AppError(
        "VALIDATION_FAILED",
        "Parámetros de exportación inválidos.",
        parsed.error.flatten().fieldErrors
      )
    );
  }

  // ── 4. Fetch cases (max 1000, explicit tenant_id filter) ─────────────────
  let cases;
  try {
    cases = await listCasesForExport(userRow.tenant_id, {
      status: parsed.data.status,
      type: parsed.data.type,
      q: parsed.data.q,
    });
  } catch (error) {
    const errName = error instanceof Error ? error.name : "UnknownError";
    console.error("[GET /api/cases/export.csv] query error:", errName, ip);
    return err(new AppError("INTERNAL_ERROR"));
  }

  // ── 5. Build CSV rows ─────────────────────────────────────────────────────
  const rows = cases.map((c) => [
    c.id,                                               // Nro. Siniestro (UUID)
    c.policyholder_name ?? "",                           // Asegurado
    c.policy_number ?? "",                               // Póliza
    c.claim_type ? (CLAIM_TYPE_LABELS[c.claim_type] ?? c.claim_type) : "",  // Tipo
    STATUS_LABELS[c.status] ?? c.status,                // Estado
    // Drizzle numeric → string; convert to number at the boundary.
    formatConfidence(c.confidence_min === null ? null : Number(c.confidence_min)), // Confianza
    formatDate(c.created_at),                           // Fecha
    c.assigned_to ?? "",                                 // Analista (UUID — W5 will join name)
  ]);

  const csv = buildCsv(CSV_HEADERS, rows);

  // ── 6. Build filename with today's date ───────────────────────────────────
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = `casos_${today}.csv`;

  // ── 7. Return CSV response ────────────────────────────────────────────────
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Prevent caching of potentially sensitive exported data
      "Cache-Control": "no-store, no-cache",
      // Forward the security headers that proxy.ts sets — needed on API responses
      "X-Content-Type-Options": "nosniff",
    },
  });
}
