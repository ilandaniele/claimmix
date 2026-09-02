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
import { CaseQuerySchema, type CaseStatus, type ClaimType } from "@/lib/schemas/cases";
import { getT, type TranslationKey } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
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
import { diaArgentino } from "@/core/fecha/dia-argentino";

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

/*
 * Los nombres de tipo y estado, del mismo diccionario que las pantallas.
 *
 * Acá había dos mapas escritos a mano con 4 de los 9 tipos y 5 de los 13
 * estados. Todo lo que faltaba salía con la clave pelada: una denuncia de
 * responsabilidad civil aparecía como `rc` y una lista para el core como
 * `listo_para_core`. El CSV es lo único de esto que ve alguien de afuera —se
 * abre en Excel, se manda por correo, se archiva— y se leía peor que la
 * pantalla.
 *
 * Los `Record<ClaimType, …>` y `Record<CaseStatus, …>` son a propósito: si
 * mañana se agrega un estado al esquema, esto no compila. Un mapa
 * `Record<string, string>` es exactamente cómo se llegó a que faltaran ocho sin
 * que nadie se enterara.
 */
export function etiquetasDeTipo(
  t: (k: TranslationKey) => string
): Record<ClaimType, string> {
  return {
    choque: t("type.choque"),
    robo: t("type.robo"),
    granizo: t("type.granizo"),
    incendio: t("type.incendio"),
    cristales: t("type.cristales"),
    rc: t("type.rc"),
    robo_contenido: t("type.robo_contenido"),
    accidente_personal: t("type.accidente_personal"),
    other: t("type.other"),
  };
}

export function etiquetasDeEstado(
  t: (k: TranslationKey) => string
): Record<CaseStatus, string> {
  return {
    procesando: t("status.procesando"),
    listo: t("status.listo"),
    esperando: t("status.esperando"),
    escalado: t("status.escalado"),
    cerrado: t("status.cerrado"),
    recibido: t("status.recibido"),
    info_faltante: t("status.info_faltante"),
    confirmacion_pendiente: t("status.confirmacion_pendiente"),
    requiere_especialista: t("status.requiere_especialista"),
    listo_para_core: t("status.listo_para_core"),
    enviado_a_core: t("status.enviado_a_core"),
    error_core: t("status.error_core"),
    no_relevante: t("status.no_relevante"),
  };
}

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
  // Los mismos filtros que la pantalla, no tres de ocho.
  //
  // Leía sólo status/type/q, así que quien filtraba la bandeja por severidad,
  // canal o is_claim y tocaba Exportar se bajaba mil filas SIN esos filtros y
  // sin ningún aviso: el CSV decía otra cosa que la pantalla desde la que se
  // pidió.
  const rawQuery = {
    status: searchParams.get("status") ?? undefined,
    type: searchParams.get("type") ?? undefined,
    q: searchParams.get("q") ?? undefined,
    severity: searchParams.get("severity") ?? undefined,
    channel: searchParams.get("channel") ?? undefined,
    is_claim: searchParams.get("is_claim") ?? undefined,
    customer_id: searchParams.get("customer_id") ?? undefined,
    policy_id: searchParams.get("policy_id") ?? undefined,
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
      severity: parsed.data.severity,
      channel: parsed.data.channel,
      is_claim: parsed.data.is_claim,
      customer_id: parsed.data.customer_id,
      policy_id: parsed.data.policy_id,
    });
  } catch (error) {
    const errName = error instanceof Error ? error.name : "UnknownError";
    console.error("[GET /api/cases/export.csv] query error:", errName, ip);
    return err(new AppError("INTERNAL_ERROR"));
  }

  // ── 5. Build CSV rows ─────────────────────────────────────────────────────
  // El mismo idioma que la pantalla desde la que se apretó «Exportar CSV»: un
  // archivo en castellano bajado desde la interfaz en inglés se lee como un
  // error del producto.
  const t = getT(await getServerLocale());
  const TIPOS = etiquetasDeTipo(t);
  const ESTADOS = etiquetasDeEstado(t);

  const rows = cases.map((c) => [
    c.id,                                               // Nro. Siniestro (UUID)
    c.policyholder_name ?? "",                           // Asegurado
    c.policy_number ?? "",                               // Póliza
    c.claim_type ? (TIPOS[c.claim_type as ClaimType] ?? c.claim_type) : "",  // Tipo
    ESTADOS[c.status as CaseStatus] ?? c.status,        // Estado
    // Drizzle numeric → string; convert to number at the boundary.
    formatConfidence(c.confidence_min === null ? null : Number(c.confidence_min)), // Confianza
    formatDate(c.created_at),                           // Fecha
    c.assigned_to ?? "",                                 // Analista (UUID — W5 will join name)
  ]);

  const csv = buildCsv(CSV_HEADERS, rows);

  // ── 6. Build filename with today's date ───────────────────────────────────
  const today = diaArgentino(); // AAAA-MM-DD, en la zona del negocio y no en UTC
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
