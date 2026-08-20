"use client";

import { useT } from "@/lib/i18n/LocaleContext";
import { esAR, type TranslationKey } from "@/lib/i18n";
import type { MissingDocRow } from "@/lib/db/types";

type MissingDoc = MissingDocRow;

interface MissingDocsListProps {
  docs: MissingDoc[];
}

type DocStatus = "pending" | "received" | "declined" | "excused";

function getDocStatus(doc: MissingDoc): DocStatus {
  if (doc.satisfied_at) return "received";
  // Before "pending": the claimant told us this document does not exist, and
  // an analyst reading "pendiente" would chase a piece of paper nobody has.
  // Kept apart from "recibido" for the opposite reason — nothing arrived, so
  // there is no file to open, and it is sometimes worth insisting.
  if (doc.declined_at) return "declined";
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
  declined: "bg-amber-100 text-amber-800",
  excused: "bg-slate-100 text-slate-600",
};

export function MissingDocsList({ docs }: MissingDocsListProps) {
  const t = useT();

  const STATUS_LABELS: Record<DocStatus, string> = {
    pending: t("doc.status.pending"),
    received: t("doc.status.received"),
    declined: t("doc.status.declined"),
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
            className="flex items-start justify-between gap-3"
          >
            <span className="text-sm text-slate-700">
              {docLabel(doc.doc_key, t)}
              {status === "declined" && doc.declined_note ? (
                // What they actually said. "No lo tienen" on its own gives an
                // analyst nothing to judge whether to insist.
                <span className="mt-0.5 block text-xs italic text-slate-500">
                  &ldquo;{doc.declined_note}&rdquo;
                </span>
              ) : null}
            </span>
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
