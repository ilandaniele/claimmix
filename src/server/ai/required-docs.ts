/**
 * Required documents configuration — in-memory version of the required_docs_config seed table.
 *
 * T17: Table-driven gap analysis. This mirrors supabase/migrations/0003_seed_required_docs.sql
 * so the gap-analysis logic works correctly in unit tests without a live DB.
 *
 * Spec required docs per claim type:
 *   choque:   parte_amistoso (req), fotos_danos (req), licencia_conducir (req)
 *   robo:     denuncia_policial (req), fotos_lugar (req)
 *   granizo:  foto_oblea_vtv (req), fotos_danos (req)
 *   incendio: informe_bomberos (req), fotos_danos (req), denuncia_policial (req)
 */

import type { ClaimType } from "@/lib/schemas/cases";

export interface RequiredDoc {
  doc_key: string;
  label_es: string;
  required: boolean;
}

/** Static required-docs config keyed by claim type. */
export const REQUIRED_DOCS_CONFIG: Record<ClaimType, readonly RequiredDoc[]> = {
  choque: [
    { doc_key: "parte_amistoso", label_es: "Parte amistoso de accidente", required: true },
    { doc_key: "fotos_danos", label_es: "Fotos de los daños", required: true },
    { doc_key: "licencia_conducir", label_es: "Licencia de conducir", required: true },
  ],
  robo: [
    { doc_key: "denuncia_policial", label_es: "Denuncia policial", required: true },
    { doc_key: "fotos_lugar", label_es: "Fotos del lugar del robo", required: true },
  ],
  granizo: [
    { doc_key: "foto_oblea_vtv", label_es: "Foto de la oblea VTV", required: true },
    { doc_key: "fotos_danos", label_es: "Fotos de los daños por granizo", required: true },
  ],
  incendio: [
    { doc_key: "informe_bomberos", label_es: "Informe de bomberos", required: true },
    { doc_key: "fotos_danos", label_es: "Fotos de los daños por incendio", required: true },
    { doc_key: "denuncia_policial", label_es: "Denuncia policial", required: true },
  ],
  // "other" claim types have no pre-configured required docs — reviewed case by case.
  other: [],
};

/**
 * Get all required docs for a claim type.
 * Returns only docs where required=true.
 */
export function getRequiredDocs(claimType: ClaimType): readonly RequiredDoc[] {
  return (REQUIRED_DOCS_CONFIG[claimType] ?? []).filter((d) => d.required);
}

/**
 * Get all doc keys (required and optional) for a claim type.
 */
export function getAllDocKeys(claimType: ClaimType): readonly string[] {
  return (REQUIRED_DOCS_CONFIG[claimType] ?? []).map((d) => d.doc_key);
}
