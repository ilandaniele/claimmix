/**
 * GET /api/cases/:id/agent-run — latest agent run + live extraction data for
 * the case preview panel.
 *
 * Fixes the "preview values not loading" bug: the panel fetches this endpoint
 * client-side with cache: 'no-store' keyed by case id, so it always reflects
 * the CURRENT case (no stale router-cache payloads from another email) and it
 * can poll while the case is still 'procesando' (extraction in flight).
 *
 * Auth: any authenticated role (viewers may inspect). Explicit tenant_id
 * filters scope the tenant (RLS is gone); wrong-tenant case → 404 (never 403 —
 * no tenant enumeration).
 *
 * Response:
 *   {
 *     case_status, is_claim,
 *     run: AgentRunRow | null,   // includes input email, raw output JSON,
 *                                // confidence payload, trainability
 *     extracted_fields: [...],   // current (analyst-corrected) values
 *     missing_docs: [...],
 *     pending_confirmations: [...],
 *     already_approved: boolean  // training example exists for this run
 *   }
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { and, asc, eq, isNull } from "drizzle-orm";
import { requireRole, ALL_ROLES } from "@/lib/auth/require-role";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import {
  cases,
  claimFieldConfirmations,
  extractedFields,
  missingDocs,
  trainingExamples,
} from "@/lib/db/schema";
import { ok, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";
import { getLatestAgentRun } from "@/server/training/agent-runs";
import {
  rateLimit,
  RATE_LIMIT_CONFIGS,
  buildUserKey,
} from "@/lib/rate-limit/index";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    // ── 1. Auth ──────────────────────────────────────────────────────────────
    const { user, userRow } = await requireRole(...ALL_ROLES);
    const tenantId = userRow.tenant_id;
      // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
      // Este contexto es lo único que le dice de quién son los datos.
      const tenantCtx: TenantContext = { tenantId: tenantId };

    // ── 2. Rate limit ────────────────────────────────────────────────────────
    const rl = await rateLimit(
      buildUserKey(user.id, "agent-run"),
      RATE_LIMIT_CONFIGS.CASES_API
    );
    if (!rl.allowed) return err(new AppError("RATE_LIMITED"));

    // ── 3. Params ────────────────────────────────────────────────────────────
    const rawParams = await context.params;
    const parsed = ParamsSchema.safeParse(rawParams);
    if (!parsed.success) {
      return err(new AppError("NOT_FOUND", "El caso no existe."));
    }
    const caseId = parsed.data.id;

    // ── 4. Case (explicit tenant filter → wrong tenant = no row = 404) ───────
    const caseRow = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ id: cases.id, status: cases.status, is_claim: cases.is_claim })
          .from(cases)
          .where(eq(cases.id, caseId))
          .limit(1)
      )
    );
    if (!caseRow) {
      return err(new AppError("NOT_FOUND", "El caso no existe o no tenés acceso."));
    }

    // ── 5. Latest run + current extraction state, in parallel ────────────────
    // Each related query degrades to [] on failure — matching the previous
    // behavior where query errors yielded empty arrays.
    const [run, fieldRows, missingRows, confirmationRows] = await Promise.all([
      getLatestAgentRun(tenantId, caseId),
      enTenant(tenantCtx, (db) =>
        db
          .select({
            field_key: extractedFields.field_key,
            field_value: extractedFields.field_value,
            confidence: extractedFields.confidence,
            extracted_at: extractedFields.extracted_at,
          })
          .from(extractedFields)
          .where(
            eq(extractedFields.case_id, caseId)
          )
          .orderBy(asc(extractedFields.field_key))
      ).catch(() => []),
      enTenant(tenantCtx, (db) =>
        db
          .select({
            doc_key: missingDocs.doc_key,
            satisfied_at: missingDocs.satisfied_at,
          })
          .from(missingDocs)
          .where(
            and(
              eq(missingDocs.case_id, caseId),
              isNull(missingDocs.satisfied_at)
            )
          )
      ).catch(() => []),
      enTenant(tenantCtx, (db) =>
        db
          .select({
            // Neon column names are field_name / suggested_value — aliased to
            // preserve the previous field_key / proposed_value response shape.
            field_key: claimFieldConfirmations.field_name,
            proposed_value: claimFieldConfirmations.suggested_value,
            confidence: claimFieldConfirmations.confidence,
            status: claimFieldConfirmations.status,
          })
          .from(claimFieldConfirmations)
          .where(
            and(
              eq(claimFieldConfirmations.case_id, caseId),
              eq(claimFieldConfirmations.status, "pending")
            )
          )
      ).catch(() => []),
    ]);

    // ── 6. Already approved? ─────────────────────────────────────────────────
    let alreadyApproved = false;
    if (run) {
      const existing = firstRow(
        await enTenant(tenantCtx, (db) =>
          db
            .select({ id: trainingExamples.id })
            .from(trainingExamples)
            .where(
              eq(trainingExamples.agent_run_id, run.id)
            )
            .limit(1)
        ).catch(() => [] as Array<{ id: string }>)
      );
      alreadyApproved = Boolean(existing);
    }

    // numeric columns come back as strings from Drizzle — convert so the JSON
    // shape matches the previous PostgREST response (numbers).
    return ok({
      case_status: caseRow.status,
      is_claim: caseRow.is_claim,
      run,
      extracted_fields: fieldRows.map((f) => ({
        ...f,
        confidence: Number(f.confidence),
      })),
      missing_docs: missingRows,
      pending_confirmations: confirmationRows.map((c) => ({
        ...c,
        confidence: Number(c.confidence),
      })),
      already_approved: alreadyApproved,
    });
  } catch (e) {
    return err(e);
  }
}
