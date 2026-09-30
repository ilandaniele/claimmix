import type { CoreSyncPayload } from "./client";

/** Lo que el armado lee del caso: las columnas que selecciona sync-to-core. */
export interface CasoParaElCore {
  id: string;
  tenant_id: string;
  claim_type: string | null;
  severity: string | null;
  policy_number: string | null;
  policyholder_name: string | null;
  /** En ISO (`columnasDelCaso.updated_at`), no el texto de Postgres: arma X-ClaimMix-Event-Id. */
  updated_at: string | null;
}

export function armarPayload(
  caso: CasoParaElCore,
  campos: ReadonlyArray<{ field_key: string; field_value: string }>
): CoreSyncPayload {
  const extraidos: Record<string, string> = {};
  for (const c of campos) extraidos[c.field_key] = c.field_value;

  return {
    caseId: caso.id,
    tenantId: caso.tenant_id,
    claimType: caso.claim_type ?? "unknown",
    severity: caso.severity ?? null,
    customerName: caso.policyholder_name ?? extraidos.full_name ?? null,
    policyNumber: caso.policy_number ?? extraidos.policy_number ?? null,
    accidentDate: extraidos.accident_date ?? null,
    accidentDescription: extraidos.accident_description ?? null,
    extractedFields: extraidos,
    updatedAt: caso.updated_at,
  };
}
