/**
 * MissingDocsList — renders the list of required documents and their status.
 *
 * AC14: List of required docs with status chips:
 *   - "Pendiente" (red chip)   — requested_at set, satisfied_at null
 *   - "Recibido" (green chip)  — satisfied_at set
 *   - "Excusado" (gray chip)   — neither date set (created without request)
 */

import { t, esAR, type TranslationKey } from "@/lib/i18n";
import type { Database } from "@/lib/supabase/types";

type MissingDoc = Database["public"]["Tables"]["missing_docs"]["Row"];

interface MissingDocsListProps {
  docs: MissingDoc[];
}

type DocStatus = "pending" | "received" | "excused";

function getDocStatus(doc: MissingDoc): DocStatus {
  if (doc.satisfied_at) return "received";
  if (doc.requested_at) return "pending";
  return "excused";
}

function docLabel(key: string): string {
  const i18nKey = `docs.${key}` as TranslationKey;
  if (i18nKey in esAR) {
    return t(i18nKey);
  }
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const STATUS_CONFIG: Record<
  DocStatus,
  { label: string; classes: string }
> = {
  pending: {
    label: t("doc.status.pending"),
    classes: "bg-red-100 text-red-700",
  },
  received: {
    label: t("doc.status.received"),
    classes: "bg-green-100 text-green-700",
  },
  excused: {
    label: t("doc.status.excused"),
    classes: "bg-slate-100 text-slate-600",
  },
};

export function MissingDocsList({ docs }: MissingDocsListProps) {
  if (docs.length === 0) {
    return (
      <p className="text-sm text-slate-400" role="status">
        {t("case.detail.noMissingDocs")}
      </p>
    );
  }

  return (
    <ul
      className="space-y-2"
      aria-label="Lista de documentación requerida"
      role="list"
    >
      {docs.map((doc) => {
        const status = getDocStatus(doc);
        const config = STATUS_CONFIG[status];

        return (
          <li
            key={doc.id}
            className="flex items-center justify-between gap-3"
          >
            <span className="text-sm text-slate-700">{docLabel(doc.doc_key)}</span>
            <span
              className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${config.classes}`}
              aria-label={`Estado del documento: ${config.label}`}
            >
              {config.label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
