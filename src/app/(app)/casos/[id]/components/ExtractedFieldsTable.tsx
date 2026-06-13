"use client";

import { useT } from "@/lib/i18n/LocaleContext";
import { esAR, type TranslationKey } from "@/lib/i18n";
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
}

function fieldLabel(
  key: string,
  t: (key: TranslationKey) => string
): string {
  const i18nKey = `field.${key}` as TranslationKey;
  if (i18nKey in esAR) {
    return t(i18nKey);
  }
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface MiniBarProps {
  value: number;
}

function MiniConfidenceBar({ value }: MiniBarProps) {
  const pct = Math.round(value * 100);

  let trackColor: string;
  let fillColor: string;
  let textColor: string;

  if (value >= 0.7) {
    trackColor = "bg-green-100";
    fillColor = "bg-green-500";
    textColor = "text-green-700";
  } else if (value >= 0.5) {
    trackColor = "bg-yellow-100";
    fillColor = "bg-yellow-500";
    textColor = "text-yellow-700";
  } else {
    trackColor = "bg-red-100";
    fillColor = "bg-red-500";
    textColor = "text-red-700";
  }

  return (
    <div
      className="flex items-center gap-2"
      aria-label={`Confianza: ${pct}%`}
      role="meter"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-1.5 w-16 rounded-full ${trackColor} overflow-hidden`}
        aria-hidden="true"
      >
        <div
          className={`h-full rounded-full ${fillColor} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs tabular-nums font-medium ${textColor}`}>
        {pct}%
      </span>
    </div>
  );
}

export function ExtractedFieldsTable({ fields }: ExtractedFieldsTableProps) {
  const t = useT();

  if (fields.length === 0) {
    return (
      <p className="text-sm text-slate-400" role="status">
        {t("case.detail.noFields")}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table
        className="w-full text-sm table-auto"
        aria-label="Campos extraídos por IA"
      >
        <thead>
          <tr>
            <th
              scope="col"
              className="pb-3 pt-1 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 pr-4"
            >
              {t("case.detail.field")}
            </th>
            <th
              scope="col"
              className="pb-3 pt-1 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 pr-4"
            >
              {t("case.detail.value")}
            </th>
            <th
              scope="col"
              className="pb-3 pt-1 text-left text-xs font-semibold uppercase tracking-wide text-slate-400"
            >
              {t("case.detail.confidence.col")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {fields.map((field) => (
            <tr key={field.id} className="hover:bg-slate-50 transition-colors">
              <td className="py-2.5 pr-4 font-medium text-slate-700 whitespace-nowrap">
                {fieldLabel(field.field_key, t)}
              </td>
              <td className="py-2.5 pr-4 text-slate-600 break-words max-w-xs">
                {field.field_value}
              </td>
              <td className="py-2.5">
                <MiniConfidenceBar value={parseFloat(String(field.confidence))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
