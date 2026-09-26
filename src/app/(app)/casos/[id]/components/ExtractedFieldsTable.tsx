"use client";

import { useT } from "@/lib/i18n/LocaleContext";
import { canonicalFieldKey, CAMPOS_CLAVE } from "@/lib/labels/claim-fields";
import { etiquetaDeCampo, tieneEtiqueta, valorParaMostrar } from "@/lib/labels/etiqueta-de-campo";
import { ConfidenceBar } from "@/app/(app)/_components/ui";

interface ExtractedField {
  id: string;
  case_id: string;
  tenant_id: string;
  field_key: string;
  field_value: string;
  confidence: number;
  extracted_at: string;
}

interface ExtractedFieldsTableProps {
  fields: ExtractedField[];
  hoy: string;
}

const CAMPOS_CLAVE_SET = new Set(CAMPOS_CLAVE);

/** Un email sin arroba no es un dato: es ruido que el extractor a veces deja. */
function esEmailInvalido(canon: string, valor: string): boolean {
  return canon === "email" && !valor.includes("@");
}

/**
 * Una fila por hecho, no por alias.
 *
 * El extractor emite `numero_poliza` y `policy_number` para el mismo dato,
 * cada uno con su propia fila y su propia confianza. Esto se queda con la de
 * mayor confianza y, a igualdad, con la más reciente.
 */
function agruparPorClaveCanonica(fields: ExtractedField[]): ExtractedField[] {
  const porClave = new Map<string, ExtractedField>();

  for (const field of fields) {
    const canon = canonicalFieldKey(field.field_key);
    if (esEmailInvalido(canon, field.field_value)) continue;

    const actual = porClave.get(canon);
    const gana =
      !actual ||
      field.confidence > actual.confidence ||
      (field.confidence === actual.confidence && field.extracted_at > actual.extracted_at);
    if (gana) porClave.set(canon, field);
  }

  return Array.from(porClave.values());
}

export function ExtractedFieldsTable({ fields, hoy }: ExtractedFieldsTableProps) {
  const t = useT();

  if (fields.length === 0) {
    return (
      <p className="text-sm text-slate-500" role="status">
        {t("case.detail.noFields")}
      </p>
    );
  }

  const agrupados = agruparPorClaveCanonica(fields);
  const conocidos = agrupados.filter((f) => tieneEtiqueta(f.field_key));
  const tecnicos = agrupados.filter((f) => !tieneEtiqueta(f.field_key));

  return (
    <div className="overflow-x-auto">
      {conocidos.length > 0 && (
        <table className="w-full text-sm table-auto" aria-label="Campos extraídos por IA">
          <thead>
            <tr>
              <th
                scope="col"
                className="pb-3 pt-1 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 pr-4"
              >
                {t("case.detail.field")}
              </th>
              <th
                scope="col"
                className="pb-3 pt-1 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 pr-4"
              >
                {t("case.detail.value")}
              </th>
              <th
                scope="col"
                className="pb-3 pt-1 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                {t("case.detail.confidence.col")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {conocidos.map((field) => {
              const canon = canonicalFieldKey(field.field_key);
              return (
                <tr key={field.id} className="hover:bg-slate-50 transition-colors">
                  <td className="py-2.5 pr-4 font-medium text-slate-700 whitespace-nowrap">
                    {etiquetaDeCampo(field.field_key, t)}
                  </td>
                  <td className="py-2.5 pr-4 text-slate-600 break-words max-w-xs">
                    {valorParaMostrar(field.field_key, field.field_value, t, hoy)}
                  </td>
                  <td className="py-2.5">
                    {CAMPOS_CLAVE_SET.has(canon) ? <ConfidenceBar value={field.confidence} /> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {tecnicos.length > 0 && (
        <details className="mt-4 rounded-lg border border-slate-200">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-xs font-medium text-slate-500 hover:bg-slate-50">
            {t("case.detail.technicalData")}
          </summary>
          <ul className="space-y-1 border-t border-slate-100 px-4 py-3">
            {tecnicos.map((field) => (
              <li key={field.id} className="text-xs text-slate-600">
                <span className="font-mono text-slate-500">{field.field_key}</span>:{" "}
                {field.field_value}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
