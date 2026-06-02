/**
 * Case detail page — Server Component.
 *
 * AC14: Fetches case + extracted_fields + missing_docs + audit_log.
 *       Renders header (case number, claim type badge, status, assigned analyst, age),
 *       insured data section, extracted fields table, missing docs list,
 *       raw intake text accordion, and audit log timeline.
 *
 * AC15: Passes case to CaseDetailClient which renders FSM-aware action buttons.
 *
 * Protected by proxy.ts — unauthenticated access redirects to /login.
 * IDOR: getCaseDetail uses user-scoped Supabase client (RLS-enforced).
 */

import { notFound } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { getCaseDetail } from "@/server/cases/get";
import { CaseDetailClient } from "./CaseDetailClient";
import { ExtractedFieldsTable } from "./components/ExtractedFieldsTable";
import { MissingDocsList } from "./components/MissingDocsList";
import { AuditTimeline } from "./components/AuditTimeline";
import { StatusBadge } from "@/app/(app)/bandeja/components/StatusBadge";
import { formatAge, formatDate } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { CaseStatus, ClaimType } from "@/lib/schemas/cases";
import Link from "next/link";

interface CaseDetailPageProps {
  params: Promise<{ id: string }>;
}

const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
  choque: t("type.choque"),
  robo: t("type.robo"),
  granizo: t("type.granizo"),
  incendio: t("type.incendio"),
};

const CHANNEL_LABELS: Record<string, string> = {
  email_sim: "Email simulado",
  email: "Email",
  whatsapp_sim: "WhatsApp simulado",
  whatsapp: "WhatsApp",
};

/** Format case UUID to display SIN-XXXX-XXXX string */
function formatCaseNumber(id: string): string {
  const suffix = id.replace(/-/g, "").slice(-8).toUpperCase();
  return `SIN-${suffix.slice(0, 4)}-${suffix.slice(4)}`;
}

export default async function CaseDetailPage({ params }: CaseDetailPageProps) {
  const { id } = await params;

  const supabase = await createServerClient();
  const detail = await getCaseDetail(supabase, id);

  if (!detail) {
    notFound();
  }

  const { case: caseRow, extracted_fields, missing_docs, audit_log } = detail;

  const caseNumber = formatCaseNumber(caseRow.id);

  return (
    <div className="px-6 py-6 max-w-5xl mx-auto">
      {/* Back button */}
      <div className="mb-4">
        <Link
          href="/bandeja"
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors"
          aria-label={t("case.detail.back")}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
              clipRule="evenodd"
            />
          </svg>
          {t("case.detail.back")}
        </Link>
      </div>

      {/* Header card */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 mb-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex-1 min-w-0">
            {/* Case number + claim type badge */}
            <div className="flex items-center gap-3 mb-2 flex-wrap">
              <h1 className="text-xl font-semibold text-slate-900 font-mono">
                {caseNumber}
              </h1>
              <span className="inline-flex items-center rounded-md bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700 capitalize">
                {CLAIM_TYPE_LABELS[caseRow.claim_type] ?? caseRow.claim_type}
              </span>
              <StatusBadge status={caseRow.status as CaseStatus} />
            </div>

            {/* Meta info row */}
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-500">
              <span>
                <span className="font-medium text-slate-700">
                  {t("case.detail.assignedTo")}:
                </span>{" "}
                {caseRow.assigned_to ? "Asignado" : "Sin asignar"}
              </span>
              <span>
                <span className="font-medium text-slate-700">Creado:</span>{" "}
                Hace {formatAge(caseRow.created_at)}
              </span>
              {caseRow.created_at && (
                <span title={caseRow.created_at}>
                  {formatDate(caseRow.created_at)}
                </span>
              )}
            </div>
          </div>

          {/* Action buttons — client component handles FSM state */}
          <CaseDetailClient
            caseId={caseRow.id}
            status={caseRow.status as CaseStatus}
            caseNumber={caseNumber}
          />
        </div>
      </div>

      {/* Two-column layout: left = main content, right = docs + audit */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column — 2/3 width */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          {/* Datos del asegurado */}
          <section
            aria-labelledby="insured-data-heading"
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <h2
              id="insured-data-heading"
              className="text-sm font-semibold text-slate-900 mb-4"
            >
              {t("case.detail.insuredData")}
            </h2>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <dt className="text-slate-500">{t("case.detail.policyholderName")}</dt>
                <dd className="mt-0.5 font-medium text-slate-900">
                  {caseRow.policyholder_name ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("case.detail.policyNumber")}</dt>
                <dd className="mt-0.5 font-mono text-slate-900">
                  {caseRow.policy_number ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("case.detail.channel")}</dt>
                <dd className="mt-0.5 text-slate-900">
                  {CHANNEL_LABELS[caseRow.channel] ?? caseRow.channel}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("case.detail.confidence.col")}</dt>
                <dd className="mt-0.5 text-slate-900">
                  {caseRow.confidence_min != null
                    ? `${Math.round(caseRow.confidence_min * 100)}%`
                    : "—"}
                </dd>
              </div>
            </dl>
          </section>

          {/* Campos extraídos */}
          <section
            aria-labelledby="extracted-fields-heading"
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <h2
              id="extracted-fields-heading"
              className="text-sm font-semibold text-slate-900 mb-4"
            >
              {t("case.detail.extractedFields")}
            </h2>
            <ExtractedFieldsTable fields={extracted_fields} />
          </section>

          {/* Texto original — collapsible accordion */}
          <section
            aria-labelledby="raw-email-heading"
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <h2
              id="raw-email-heading"
              className="text-sm font-semibold text-slate-900 mb-4"
            >
              {t("case.detail.rawEmail")}
            </h2>
            <RawEmailAccordion caseId={caseRow.id} />
          </section>
        </div>

        {/* Right column — 1/3 width */}
        <div className="flex flex-col gap-6">
          {/* Documentación faltante */}
          <section
            aria-labelledby="missing-docs-heading"
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <h2
              id="missing-docs-heading"
              className="text-sm font-semibold text-slate-900 mb-4"
            >
              {t("case.detail.missingDocs")}
            </h2>
            <MissingDocsList docs={missing_docs} />
          </section>

          {/* Historial */}
          <section
            aria-labelledby="audit-log-heading"
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <h2
              id="audit-log-heading"
              className="text-sm font-semibold text-slate-900 mb-4"
            >
              {t("case.detail.auditLog")}
            </h2>
            <AuditTimeline events={audit_log} />
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * RawEmailAccordion — server-fetches the raw_messages for this case
 * and renders them in a collapsible details element.
 *
 * Isolated here so it can be wrapped in <Suspense> later.
 */
async function RawEmailAccordion({ caseId }: { caseId: string }) {
  const supabase = await createServerClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: messages } = await (supabase as any)
    .from("raw_messages")
    .select("body, subject, received_at")
    .eq("case_id", caseId)
    .order("received_at", { ascending: true })
    .limit(5);

  if (!messages || messages.length === 0) {
    return (
      <p className="text-sm text-slate-400">Sin texto original disponible.</p>
    );
  }

  return (
    <div className="space-y-3">
      {messages.map(
        (
          msg: { body: string; subject: string | null; received_at: string },
          idx: number
        ) => (
          <details
            key={idx}
            className="group rounded-lg border border-slate-200"
          >
            <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 rounded-lg select-none list-none">
              <span>
                {msg.subject
                  ? `Asunto: ${msg.subject}`
                  : t("case.detail.rawEmailToggle")}
              </span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-4 h-4 text-slate-400 transition-transform group-open:rotate-180"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
                  clipRule="evenodd"
                />
              </svg>
            </summary>
            <pre className="px-4 pb-4 pt-2 text-xs text-slate-600 whitespace-pre-wrap font-mono leading-relaxed border-t border-slate-100">
              {msg.body}
            </pre>
          </details>
        )
      )}
    </div>
  );
}
