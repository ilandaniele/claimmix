/**
 * Case detail query — `GET /api/cases/:id`.
 *
 * Returns the full case with related extracted_fields, missing_docs,
 * and the last 20 audit_log entries (sorted descending by created_at).
 *
 * IDOR protection:
 * - Every query filters explicitly by tenant_id (RLS is gone — the
 *   explicit filter is the ONLY tenant boundary).
 * - A case belonging to another tenant returns zero rows.
 * - The route handler converts a missing row to 404 (not 403) to
 *   prevent tenant enumeration (AC10).
 *
 * AC14: Returns extracted_fields[] with per-field confidence, missing_docs[], audit_log[].
 * AC10: Wrong-tenant case returns null (caller returns 404 NOT_FOUND).
 */

import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { auditLog, cases, extractedFields, missingDocs } from "@/lib/db/schema";
import type {
  AuditLogRow,
  CaseRow,
  ExtractedFieldRow,
  MissingDocRow,
} from "@/lib/db/types";

/**
 * Un evento del historial, tal como lo necesita quien lo muestra.
 *
 * NO es `AuditLogRow`: esa es la fila entera de la base, con `ip`, `ua`,
 * `actor_id` y el payload completo. Lo que sale de acá va al navegador.
 */
export interface AuditLogEntry {
  id: number;
  event_type: string;
  created_at: string;
  /** El motivo, cuando el evento trae uno. Es lo único del payload que se muestra. */
  reason: string | null;
}

export interface CaseDetail {
  case: CaseRow;
  extracted_fields: ExtractedFieldRow[];
  missing_docs: MissingDocRow[];
  audit_log: AuditLogEntry[];
}

/**
 * Fetch a case with all related data.
 *
 * Returns null if:
 * - The case does not exist.
 * - The case belongs to a different tenant (explicit tenant filter → zero rows).
 *
 * The caller MUST use this null signal to return a 404 response.
 * NEVER return 403 — doing so leaks the existence of the resource
 * to a potential attacker (IDOR enumeration).
 *
 * @param tenantId - Tenant of the authenticated user (explicit tenant boundary).
 * @param caseId   - UUID of the case to fetch.
 */
/**
 * La fila del caso, o null si no existe o es de otra aseguradora.
 *
 * El null es el ÚNICO camino a un 404, y por eso también atrapa los errores:
 * un uuid mal formado tiene que verse igual que un caso ajeno. Contestar
 * distinto ya permite enumerar los casos de la competencia.
 */
export async function fetchCaseRow(
  ctx: TenantContext,
  caseId: string
): Promise<CaseRow | null> {
  try {
    return firstRow(
      await enTenant(ctx, (db) =>
        db.select().from(cases).where(eq(cases.id, caseId)).limit(1)
      )
    );
  } catch {
    return null;
  }
}

/*
 * Las tres relacionadas, cada una con SU propio `.catch`.
 *
 * Están separadas porque cada una es su propio dominio de falla, y eso es una
 * decisión, no un accidente: un hipo leyendo el historial de auditoría no puede
 * llevarse puestos los campos extraídos. Por eso tampoco pueden juntarse en un
 * `enTenantVarias`, que es UNA transacción — hay tests que lo fijan en
 * `tests/unit/cases-get.test.ts`.
 *
 * Salen como funciones sueltas para que la pantalla de detalle pueda pedirlas
 * en la misma tanda que las suyas sin volver a escribirlas.
 */

/** Los campos que el agente extrajo, del más viejo al más nuevo. */
export async function fetchExtractedFields(
  ctx: TenantContext,
  caseId: string
): Promise<ExtractedFieldRow[]> {
  try {
    return (await enTenant(ctx, (db) =>
      db
        .select()
        .from(extractedFields)
        .where(eq(extractedFields.case_id, caseId))
        .orderBy(asc(extractedFields.extracted_at))
    )) as ExtractedFieldRow[];
  } catch {
    return [];
  }
}

/** La documentación que todavía falta. */
export async function fetchMissingDocs(
  ctx: TenantContext,
  caseId: string
): Promise<MissingDocRow[]> {
  try {
    return (await enTenant(ctx, (db) =>
      db
        .select()
        .from(missingDocs)
        .where(eq(missingDocs.case_id, caseId))
        .orderBy(asc(missingDocs.requested_at))
    )) as MissingDocRow[];
  } catch {
    return [];
  }
}

/**
 * Las últimas veinte cosas que le pasaron al caso.
 *
 * Cuatro columnas, no la fila entera.
 *
 * Era un `select()` pelado, así que al navegador le llegaba también `ip` y `ua`
 * —de qué computadora y con qué navegador trabajó cada analista— y el `payload`
 * completo de cada evento. La pantalla muestra el tipo, la fecha y, si lo hay,
 * el motivo. Nada más.
 *
 * Esto se volvió concreto el día que las confirmaciones de campo empezaron a
 * guardar la IP del analista: hasta entonces la columna venía casi siempre en
 * null y el exceso no se notaba.
 */
export async function fetchAuditLog(
  ctx: TenantContext,
  caseId: string
): Promise<AuditLogEntry[]> {
  try {
    const filas = await enTenant(ctx, (db) =>
      db
        .select({
          id: auditLog.id,
          event_type: auditLog.event_type,
          created_at: auditLog.created_at,
          payload: auditLog.payload,
        })
        .from(auditLog)
        .where(and(eq(auditLog.target_type, "case"), eq(auditLog.target_id, caseId)))
        .orderBy(desc(auditLog.created_at))
        .limit(20)
    );

    return filas.map((f) => ({
      id: f.id,
      event_type: f.event_type,
      created_at: f.created_at,
      /*
       * Del payload sale sólo `reason`, que es lo único que la pantalla pinta.
       *
       * El resto llevaba claves de campo, valores viejos y nuevos, y el motivo
       * técnico de un escalado. Nada de eso se muestra, y parte es dato de la
       * persona que hizo la denuncia.
       */
      reason:
        f.payload && typeof f.payload === "object" && "reason" in f.payload
          ? String((f.payload as Record<string, unknown>).reason)
          : null,
    }));
  } catch {
    return [];
  }
}

export async function getCaseDetail(
  tenantId: string,
  caseId: string
): Promise<CaseDetail | null> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };

  const caseRow = await fetchCaseRow(tenantCtx, caseId);
  if (!caseRow) return null;

  const [extractedData, missingDocsData, auditData] = await Promise.all([
    fetchExtractedFields(tenantCtx, caseId),
    fetchMissingDocs(tenantCtx, caseId),
    fetchAuditLog(tenantCtx, caseId),
  ]);

  return {
    case: caseRow,
    extracted_fields: extractedData,
    missing_docs: missingDocsData,
    audit_log: auditData,
  };
}
