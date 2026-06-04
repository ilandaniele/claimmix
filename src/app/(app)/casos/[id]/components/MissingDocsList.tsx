"use client";

import { useT } from "@/lib/i18n/LocaleContext";
import { esAR, type TranslationKey } from "@/lib/i18n";
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

function docLabel(
  key: string,
  t: (key: TranslationKey) => string
): string {
  const i18nKey = `docs.${key}` as TranslationKey;
  if (i18nKey in esAR) {
    return t(i18nKey);
  }
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const STATUS_BADGE_CLASSES: Record<DocStatus, string> = {
  pending: "bg-red-100 text-red-700",
  received: "bg-green-100 text-green-700",
  excused: "bg-slate-100 text-slate-600",
};

export function MissingDocsList({ docs }: MissingDocsListProps) {
  const t = useT();

  const STATUS_LABELS: Record<DocStatus, string> = {
    pending: t("doc.status.pending"),
    received: t("doc.status.received"),
    excused: t("doc.status.excused"),
  };

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
        const label = STATUS_LABELS[status];
        const classes = STATUS_BADGE_CLASSES[status];

        return (
          <li
            key={doc.id}
            className="flex items-center justify-between gap-3"
          >
            <span className="text-sm text-slate-700">{docLabel(doc.doc_key, t)}</span>
            <span
              className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}
              aria-label={`Estado del documento: ${label}`}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
