/**
 * Policy matcher — finds policies linked to a customer or by policy number.
 *
 * AC6:  policy_number match sets cases.policy_id.
 * AC22: Policy match has the highest confidence (0.95).
 *
 * The tenant_id filter is always applied.
 * IDOR: Cross-tenant leakage is prevented by the tenant_id column filter.
 */

import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { tables } from "@/lib/db";
import { insuredAssets } from "@/lib/db/schema";
import { enTenant, type TenantContext } from "@/data/scope";
import { policyNumberEquals } from "@/lib/db/helpers";
import { normalizarNumeroPoliza } from "@/core/matching/normalizar";
import { logger } from "@/lib/observability/logger";

/** A single policy match result. */
export interface PolicyMatch {
  /** UUID of the matched policy row. */
  policyId: string;
  /** Human-readable policy number (PII — not logged). */
  policyNumber: string;
  /** Policy type: auto, home, life, business, other. */
  policyType: string;
  /** Policy status: active, expired, cancelled. */
  status: "active" | "expired" | "cancelled" | string;
  /** Fin de vigencia, AAAA-MM-DD, o null si no vence. */
  endDate: string | null;
  /** DNI del titular y patentes aseguradas: sólo se cruzan contra los documentos adjuntos. */
  customerDni: string | null;
  plates: string[];
  /** Full name of the policyholder (PII — not logged). */
  customerName: string;
  /** Confidence score: active policies rank higher than expired/cancelled. */
  confidence: number;
}

/**
 * Find policies by policy number (exact match) and/or by customer ID.
 *
 * @param tenantId      - Tenant scope (always applied).
 * @param policyNumber  - Optional policy number for exact-match lookup.
 * @param customerId    - Optional customer UUID — returns all policies for this customer.
 */
export async function findPolicyMatches(
  tenantId: string,
  policyNumber?: string,
  customerId?: string
): Promise<PolicyMatch[]> {
  const results: PolicyMatch[] = [];

  // ── 1. Policy number exact match ──────────────────────────────────────────────
  if (policyNumber && policyNumber.trim() !== "") {
    const matches = await matchByPolicyNumber(tenantId, policyNumber.trim());
    results.push(...matches);
  }

  // ── 2. Customer-based policy lookup ───────────────────────────────────────────
  if (customerId && customerId.trim() !== "") {
    const seenPolicyIds = new Set(results.map((r) => r.policyId));
    const customerMatches = await matchByCustomerId(tenantId, customerId.trim());
    for (const m of customerMatches) {
      if (!seenPolicyIds.has(m.policyId)) {
        results.push(m);
        seenPolicyIds.add(m.policyId);
      }
    }
  }

  // Sort: active policies first, then by confidence desc.
  results.sort((a, b) => {
    // Active policies rank higher than expired/cancelled.
    if (a.status === "active" && b.status !== "active") return -1;
    if (b.status === "active" && a.status !== "active") return 1;
    return b.confidence - a.confidence;
  });

  logger.info({
        tenant_id: tenantId,
        match_count: results.length,
      }, "policy_matcher.matches_found");

  return results;
}

// ── Private matchers ──────────────────────────────────────────────────────────

type FilaDePoliza = {
  id: string;
  policy_number: string;
  policy_type: string | null;
  status: string;
  end_date: string | null;
  customer_full_name: string | null;
  customer_dni: string | null;
  plates: Array<string | null> | null;
};

/** Las patentes de la póliza, como subconsulta de la fila de `policies`. */
export const patentesDe = (policyId: AnyPgColumn) =>
  sql<Array<string | null> | null>`(select array_agg(${insuredAssets.plate}) from ${insuredAssets} where ${insuredAssets.policy_id} = ${policyId})`;

/**
 * Las patentes van en una subconsulta y no en un join: una póliza con tres
 * autos sería tres filas, y el `limit` de abajo contaría autos, no pólizas.
 */
function columnas() {
  const p = tables.policies;
  const c = tables.customers;
  return {
    id: p.id,
    policy_number: p.policy_number,
    policy_type: p.policy_type,
    status: p.status,
    end_date: p.end_date,
    customer_full_name: c.full_name,
    customer_dni: c.dni,
    plates: patentesDe(p.id),
  };
}

async function matchByPolicyNumber(
  tenantId: string,
  policyNumber: string
): Promise<PolicyMatch[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const p = tables.policies;
  const c = tables.customers;

  let data: FilaDePoliza[];
  try {
    data = await enTenant(tenantCtx, (db) =>
      db
        .select(columnas())
        .from(p)
        .leftJoin(c, eq(p.customer_id, c.id))
        /*
         * Los dos lados sin espacios y en mayúsculas.
         *
         * `verificar_poliza` —la herramienta del agente— ya comparaba así desde
         * el día uno; este buscador comparaba en crudo. Dos caminos hacia la
         * misma tabla, uno tolerante y el otro no, y el que decide si el caso
         * queda asociado a un contrato era el estricto.
         */
        .where(policyNumberEquals(p.policy_number, normalizarNumeroPoliza(policyNumber)))
        .limit(5)
    );
  } catch (e) {
    logger.error({ detalle: (e as { code?: string })?.code }, "policy_matcher.policy_number_lookup_error");
    return [];
  }

  return data.map((row) => {
    // Active policy number match → highest confidence.
    const confidence = row.status === "active" ? 0.95 : 0.70;
    return {
      policyId: row.id,
      policyNumber: row.policy_number,
      policyType: row.policy_type ?? "other",
      status: row.status,
      endDate: row.end_date ?? null,
      customerDni: row.customer_dni ?? null,
      plates: (row.plates ?? []).filter((x): x is string => !!x),
      customerName: row.customer_full_name ?? "",
      confidence,
    };
  });
}

async function matchByCustomerId(
  tenantId: string,
  customerId: string
): Promise<PolicyMatch[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const p = tables.policies;
  const c = tables.customers;

  let data: FilaDePoliza[];
  try {
    data = await enTenant(tenantCtx, (db) =>
      db
        .select(columnas())
        .from(p)
        .leftJoin(c, eq(p.customer_id, c.id))
        .where(eq(p.customer_id, customerId))
        .orderBy(asc(p.status)) // 'active' < 'cancelled' < 'expired' alphabetically
        .limit(20)
    );
  } catch (e) {
    logger.error({ detalle: (e as { code?: string })?.code }, "policy_matcher.customer_policy_lookup_error");
    return [];
  }

  return data.map((row) => {
    // Active = 0.85 (good match from customer link, not direct policy number).
    // Expired/cancelled = 0.60 (lower — may not be the right policy for the claim).
    const confidence = row.status === "active" ? 0.85 : 0.60;
    return {
      policyId: row.id,
      policyNumber: row.policy_number,
      policyType: row.policy_type ?? "other",
      status: row.status,
      endDate: row.end_date ?? null,
      customerDni: row.customer_dni ?? null,
      plates: (row.plates ?? []).filter((x): x is string => !!x),
      customerName: row.customer_full_name ?? "",
      confidence,
    };
  });
}
