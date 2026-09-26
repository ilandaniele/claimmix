"use client";

import { useT } from "@/lib/i18n/LocaleContext";
import type { TranslationKey } from "@/lib/i18n";
import { labelForField } from "@/lib/labels/claim-fields";
import { etiquetaDeCampo } from "@/lib/labels/etiqueta-de-campo";
import { estadoDelDocumento, type EstadoDelDocumento } from "@/core/case/required-docs";
import type { MissingDocRow } from "@/lib/db/types";

type MissingDoc = MissingDocRow;

interface MissingDocsListProps {
  docs: MissingDoc[];
}

const STATUS_BADGE_CLASSES: Record<EstadoDelDocumento, string> = {
  pending: "bg-red-100 text-red-700",
  received: "bg-green-100 text-green-700",
  declined: "bg-amber-100 text-amber-800",
};

export function MissingDocsList({ docs }: MissingDocsListProps) {
  const t = useT();

  const STATUS_LABELS: Record<EstadoDelDocumento, string> = {
    pending: t("doc.status.pending"),
    received: t("doc.status.received"),
    declined: t("doc.status.declined"),
  };

  if (docs.length === 0) {
    return (
      <p className="text-sm text-slate-500" role="status">
        {t("case.detail.noMissingDocs")}
      </p>
    );
  }

  // Two different things share this table: files we asked the claimant to send,
  // and fields the extractor was unsure about. The agent has always told them
  // apart — it never asked for the time of the accident as an attachment — but
  // the page did not, so a case with everything settled showed four "pending
  // documents" that were facts, not paper.
  const files = docs.filter((d) => labelForField(d.doc_key).kind === "documento");
  const facts = docs.filter((d) => labelForField(d.doc_key).kind !== "documento");

  // One heading over one list is noise. Group only when both kinds are here.
  if (files.length === 0 || facts.length === 0) {
    return <DocGroup docs={docs} statusLabels={STATUS_LABELS} t={t} />;
  }

  return (
    <div className="space-y-5">
      <section aria-labelledby="docs-group-files">
        <h3
          id="docs-group-files"
          className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500"
        >
          {t("case.detail.docsGroup")}
        </h3>
        <DocGroup docs={files} statusLabels={STATUS_LABELS} t={t} />
      </section>

      <section aria-labelledby="docs-group-facts">
        <h3
          id="docs-group-facts"
          className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500"
        >
          {t("case.detail.fieldsGroup")}
        </h3>
        <DocGroup docs={facts} statusLabels={STATUS_LABELS} t={t} />
      </section>
    </div>
  );
}

function DocGroup({
  docs,
  statusLabels,
  t,
}: {
  docs: MissingDoc[];
  statusLabels: Record<EstadoDelDocumento, string>;
  t: (key: TranslationKey) => string;
}) {
  return (
    <ul className="space-y-2" aria-label="Lista de documentación requerida" role="list">
      {docs.map((doc) => {
        const status = estadoDelDocumento(doc);
        const label = statusLabels[status];
        const classes = STATUS_BADGE_CLASSES[status];

        return (
          <li key={doc.id} className="flex items-start justify-between gap-3">
            <span className="text-sm text-slate-700">
              {etiquetaDeCampo(doc.doc_key, t)}
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
