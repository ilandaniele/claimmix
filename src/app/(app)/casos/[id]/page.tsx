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
import { SeverityBadge } from "@/app/(app)/bandeja/components/SeverityBadge";
import { FieldConfirmationsPanel } from "./_components/FieldConfirmationsPanel";
import { AttachmentsPanel } from "./_components/AttachmentsPanel";
import { MessagesThread } from "./_components/MessagesThread";
import { CoreSyncButton } from "./_components/CoreSyncButton";
import { formatAge, formatDate } from "@/lib/utils";
import { getT } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
import { parseEmailClaimFields } from "@/lib/email/claim-parser";
import type { CaseStatus, ClaimType } from "@/lib/schemas/cases";
import type { Database } from "@/lib/supabase/types";
import Link from "next/link";

interface CaseDetailPageProps {
  params: Promise<{ id: string }>;
}

const CHANNEL_LABELS: Record<string, string> = {
  email_sim: "Email simulado",
  email: "Email",
  whatsapp_sim: "WhatsApp simulado",
  whatsapp: "WhatsApp",
};

type ExtractedFieldRow = Database["public"]["Tables"]["extracted_fields"]["Row"];

/** Format case UUID to display SIN-XXXX-XXXX string */
function formatCaseNumber(id: string): string {
  const suffix = id.replace(/-/g, "").slice(-8).toUpperCase();
  return `SIN-${suffix.slice(0, 4)}-${suffix.slice(4)}`;
}

export default async function CaseDetailPage({ params }: CaseDetailPageProps) {
  const { id } = await params;
  const locale = await getServerLocale();
  const t = getT(locale);

  const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
    choque: t("type.choque"),
    robo: t("type.robo"),
    granizo: t("type.granizo"),
    incendio: t("type.incendio"),
    other: t("type.other"),
  };

  const supabase = await createServerClient();
  const detail = await getCaseDetail(supabase, id);

  if (!detail) {
    notFound();
  }

  const { case: caseRow, extracted_fields, missing_docs, audit_log } = detail;

  // Fetch email-specific data in parallel when case is from the email channel
  const isEmailCase =
    (caseRow as any).channel === "email" ||
    (caseRow as any).channel === "email_sim";

  const [confirmationsResult, attachmentsResult] = await Promise.all([
    isEmailCase
      ? (supabase as any)
          .from("claim_field_confirmations")
          .select(
            "id,field_key,proposed_value,conflict_with_value,confidence,status,resolved_at"
          )
          .eq("case_id", id)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] }),
    isEmailCase
      ? (supabase as any)
          .from("claim_attachments")
          .select("id,filename,content_type,size_bytes,external_url,uploaded_at")
          .eq("case_id", id)
          .order("uploaded_at", { ascending: true })
      : Promise.resolve({ data: [] }),
  ]);

  const confirmations: Array<{
    id: string;
    field_key: string;
    proposed_value: string | null;
    conflict_with_value: string | null;
    confidence: number;
    status: "pending" | "confirmed" | "rejected" | "corrected";
    resolved_at: string | null;
  }> = confirmationsResult.data ?? [];

  const attachments: Array<{
    id: string;
    filename: string;
    content_type: string;
    size_bytes: number;
    external_url: string;
    uploaded_at: string | null;
  }> = attachmentsResult.data ?? [];

  let displayedExtractedFields = extracted_fields;
  if (isEmailCase && displayedExtractedFields.length === 0) {
    const fallbackEmail = await getLatestEmailText(supabase, id);
    const fallbackFields = parseEmailClaimFields(fallbackEmail);
    displayedExtractedFields = fallbackFields.map((field, index) => ({
      id: `frontend-fallback-${caseRow.id}-${field.field_key}-${index}`,
      case_id: caseRow.id,
      tenant_id: caseRow.tenant_id,
      field_key: field.field_key,
      field_value: field.field_value,
      confidence: field.confidence,
      extracted_at: caseRow.created_at,
    })) satisfies ExtractedFieldRow[];
  }

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
                {caseRow.claim_type ? (CLAIM_TYPE_LABELS[caseRow.claim_type] ?? caseRow.claim_type) : "—"}
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
                {formatAge(caseRow.created_at)}
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
            <ExtractedFieldsTable fields={displayedExtractedFields} />
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

          {/* Messages thread — only shown for email channel cases (AC11, AC12) */}
          {isEmailCase && (
            <section
              aria-labelledby="messages-thread-heading"
              className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <h2
                id="messages-thread-heading"
                className="text-sm font-semibold text-slate-900 mb-4"
              >
                {t("messages.thread.title")}
              </h2>
              <MessagesThread caseId={caseRow.id} />
            </section>
          )}

          {/* Email-specific sections — only shown for email channel cases */}
          {isEmailCase && (
            <>
              {/* Section A: Parsed email data */}
              <section
                aria-labelledby="parsed-email-heading"
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <h2
                  id="parsed-email-heading"
                  className="text-sm font-semibold text-slate-900 mb-4"
                >
                  {t("case.detail.parsedEmail")}
                </h2>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  <div>
                    <dt className="text-slate-500">{t("case.detail.isClaim")}</dt>
                    <dd className="mt-0.5 font-medium text-slate-900">
                      {(caseRow as any).is_claim === true
                        ? "Sí"
                        : (caseRow as any).is_claim === false
                        ? "No"
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{t("case.detail.severity")}</dt>
                    <dd className="mt-0.5">
                      {(caseRow as any).severity ? (
                        <SeverityBadge severity={(caseRow as any).severity} />
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </dd>
                  </div>
                  {(caseRow as any).customer_id && (
                    <div>
                      <dt className="text-slate-500">{t("case.detail.customer")}</dt>
                      <dd className="mt-0.5">
                        <Link
                          href={`/clientes/${(caseRow as any).customer_id}`}
                          className="text-blue-600 hover:underline font-medium text-sm"
                        >
                          Ver cliente
                        </Link>
                      </dd>
                    </div>
                  )}
                  {(caseRow as any).policy_id && (
                    <div>
                      <dt className="text-slate-500">{t("case.detail.policy")}</dt>
                      <dd className="mt-0.5 font-mono text-slate-800">
                        {caseRow.policy_number ?? "Vinculada"}
                      </dd>
                    </div>
                  )}
                  {attachments.length > 0 && (
                    <div>
                      <dt className="text-slate-500">{t("case.detail.attachments")}</dt>
                      <dd className="mt-0.5 font-medium text-slate-900">
                        {attachments.length} {t("case.detail.attachmentCount")}
                      </dd>
                    </div>
                  )}
                </dl>
              </section>

              {/* Section B: Field confirmations panel (AC21) */}
              <section
                aria-labelledby="field-confirmations-heading"
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <h2
                  id="field-confirmations-heading"
                  className="text-sm font-semibold text-slate-900 mb-4"
                >
                  {t("case.detail.fieldConfirmations")}
                  {confirmations.filter((c) => c.status === "pending").length > 0 && (
                    <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                      {confirmations.filter((c) => c.status === "pending").length} pendiente(s)
                    </span>
                  )}
                </h2>
                <FieldConfirmationsPanel
                  caseId={caseRow.id}
                  initialConfirmations={confirmations}
                />
              </section>

              {/* Section C: Attachments panel (AC23) */}
              <section
                aria-labelledby="attachments-heading"
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <h2
                  id="attachments-heading"
                  className="text-sm font-semibold text-slate-900 mb-4"
                >
                  {t("case.detail.attachments")}
                </h2>
                <AttachmentsPanel attachments={attachments} />
              </section>

              {/* Section D: Core sync action (AC17) */}
              {((caseRow as any).status === "listo_para_core") && (
                <section
                  aria-labelledby="core-sync-heading"
                  className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 shadow-sm"
                >
                  <h2
                    id="core-sync-heading"
                    className="text-sm font-semibold text-emerald-900 mb-4"
                  >
                    {t("case.detail.coreSyncAction")}
                  </h2>
                  <p className="text-sm text-emerald-700 mb-4">
                    Este caso está listo para ser enviado al sistema central. Revisá los campos confirmados antes de proceder.
                  </p>
                  <CoreSyncButton
                    caseId={caseRow.id}
                    currentStatus={(caseRow as any).status}
                  />
                </section>
              )}
            </>
          )}
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
  const locale = await getServerLocale();
  const t = getT(locale);
  const supabase = await createServerClient();
   
  let { data: messages } = await (supabase as any)
    .from("raw_messages")
    .select("body, subject, received_at")
    .eq("case_id", caseId)
    .order("received_at", { ascending: true })
    .limit(5);

  if (!messages || messages.length === 0) {
    const { data: claimMessages } = await (supabase as any)
      .from("claim_messages")
      .select("body_text, subject, received_at")
      .eq("case_id", caseId)
      .eq("direction", "inbound")
      .order("received_at", { ascending: true })
      .limit(5);

    messages = (claimMessages ?? []).map(
      (msg: { body_text: string | null; subject: string | null; received_at: string }) => ({
        body: msg.body_text ?? "",
        subject: msg.subject,
        received_at: msg.received_at,
      })
    );
  }

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

async function getLatestEmailText(
  supabase: any,
  caseId: string
): Promise<{ subject: string; body: string; senderEmail: string }> {
  const { data: rawMsg } = await supabase
    .from("raw_messages")
    .select("body,subject,from_addr")
    .eq("case_id", caseId)
    .order("received_at", { ascending: false })
    .limit(1)
    .single();

  if (rawMsg) {
    return {
      subject: rawMsg.subject ?? "",
      body: rawMsg.body ?? "",
      senderEmail: rawMsg.from_addr ?? "",
    };
  }

  const { data: claimMsg } = await supabase
    .from("claim_messages")
    .select("body_text,subject,from_addr")
    .eq("case_id", caseId)
    .eq("direction", "inbound")
    .order("received_at", { ascending: false })
    .limit(1)
    .single();

  return {
    subject: claimMsg?.subject ?? "",
    body: claimMsg?.body_text ?? "",
    senderEmail: claimMsg?.from_addr ?? "",
  };
}
