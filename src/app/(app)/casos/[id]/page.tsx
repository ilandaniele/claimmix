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
 * IDOR: getCaseDetail filters explicitly by tenant_id (RLS is gone) — wrong
 * tenant returns null → 404.
 */

import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq } from "drizzle-orm";
import { getSessionContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import {
  claimAttachments,
  claimFieldConfirmations,
  claimMessages,
  rawMessages,
  users,
} from "@/lib/db/schema";
import { getCaseDetail } from "@/server/cases/get";
import { CaseDetailClient } from "./CaseDetailClient";
import { ExtractedFieldsTable } from "./components/ExtractedFieldsTable";
import { MissingDocsList } from "./components/MissingDocsList";
import { AuditTimeline } from "./components/AuditTimeline";
import { StatusBadge } from "@/app/(app)/bandeja/components/StatusBadge";
import { SeverityBadge } from "@/app/(app)/bandeja/components/SeverityBadge";
import { FieldConfirmationsPanel } from "./_components/FieldConfirmationsPanel";
import { AgentRunPanel } from "./_components/AgentRunPanel";
import { AttachmentsPanel } from "./_components/AttachmentsPanel";
import { MessagesThread } from "./_components/MessagesThread";
import { CoreSyncButton } from "./_components/CoreSyncButton";
import { formatAge, formatDate } from "@/lib/utils";
import { getT } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
import { parseEmailClaimFields } from "@/lib/email/claim-parser";
import type { CaseStatus, ClaimType } from "@/lib/schemas/cases";
import Link from "next/link";

interface CaseDetailPageProps {
  params: Promise<{ id: string }>;
}

/**
 * UI shape of an extracted field — Drizzle `numeric` columns come back as
 * strings, so `confidence` is normalized to number at this boundary.
 */
interface ExtractedFieldRow {
  id: string;
  case_id: string;
  tenant_id: string;
  field_key: string;
  field_value: string;
  confidence: number;
  extracted_at: string;
}

/** Format case UUID to display SIN-XXXX-XXXX string */
function formatCaseNumber(id: string): string {
  const suffix = id.replace(/-/g, "").slice(-8).toUpperCase();
  return `SIN-${suffix.slice(0, 4)}-${suffix.slice(4)}`;
}

/** Safe jsonb → Record normalization (audit payloads are objects in practice). */
function toPayloadRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Narrow a free-text confirmation status to the UI union. */
function toConfirmationStatus(
  status: string
): "pending" | "confirmed" | "rejected" | "corrected" {
  return status === "confirmed" || status === "rejected" || status === "corrected"
    ? status
    : "pending";
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

  // Resolve session + users row (tenant boundary and role gate in one lookup).
  const session = await getSessionContext();
  if (!session?.user) {
    redirect("/login");
  }
  const me = firstRow(
    await db
      .select({ tenant_id: users.tenant_id, role: users.role })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)
  );
  if (!me) {
    redirect("/login");
  }
  const tenantId = me.tenant_id;

  const detail = await getCaseDetail(tenantId, id);

  if (!detail) {
    notFound();
  }

  // Role gate for the training confirmation button (owner/admin/specialist).
  const canConfirmTraining = ["owner", "admin", "specialist"].includes(me.role);

  const { case: caseRow, extracted_fields, missing_docs, audit_log } = detail;

  // Fetch email-specific data in parallel when case is from the email channel
  const isEmailCase =
    caseRow.channel === "email" || caseRow.channel === "email_sim";

  const [confirmationRows, attachmentRows] = await Promise.all([
    isEmailCase
      ? db
          .select({
            id: claimFieldConfirmations.id,
            field_key: claimFieldConfirmations.field_name,
            proposed_value: claimFieldConfirmations.suggested_value,
            conflict_with_value: claimFieldConfirmations.conflict_with_value,
            confidence: claimFieldConfirmations.confidence,
            status: claimFieldConfirmations.status,
            resolved_at: claimFieldConfirmations.confirmed_at,
          })
          .from(claimFieldConfirmations)
          .where(
            and(
              eq(claimFieldConfirmations.case_id, id),
              eq(claimFieldConfirmations.tenant_id, tenantId)
            )
          )
          .orderBy(asc(claimFieldConfirmations.created_at))
          .catch(() => [])
      : Promise.resolve([]),
    isEmailCase
      ? db
          .select({
            id: claimAttachments.id,
            filename: claimAttachments.file_name,
            content_type: claimAttachments.content_type,
            size_bytes: claimAttachments.size_bytes,
            external_url: claimAttachments.external_url,
            uploaded_at: claimAttachments.created_at,
          })
          .from(claimAttachments)
          .where(
            and(
              eq(claimAttachments.case_id, id),
              eq(claimAttachments.tenant_id, tenantId)
            )
          )
          .orderBy(asc(claimAttachments.created_at))
          .catch(() => [])
      : Promise.resolve([]),
  ]);

  // Boundary normalization: numeric → number, status → UI union.
  const confirmations: Array<{
    id: string;
    field_key: string;
    proposed_value: string | null;
    conflict_with_value: string | null;
    confidence: number;
    status: "pending" | "confirmed" | "rejected" | "corrected";
    resolved_at: string | null;
  }> = confirmationRows.map((row) => ({
    ...row,
    confidence: Number(row.confidence),
    status: toConfirmationStatus(row.status),
  }));

  const attachments: Array<{
    id: string;
    filename: string;
    content_type: string;
    size_bytes: number;
    external_url: string;
    uploaded_at: string | null;
  }> = attachmentRows.map((row) => ({
    ...row,
    external_url: row.external_url ?? "",
  }));

  // Boundary normalization: Drizzle numeric `confidence` arrives as string.
  let displayedExtractedFields: ExtractedFieldRow[] = extracted_fields.map(
    (field) => ({
      id: field.id,
      case_id: field.case_id,
      tenant_id: field.tenant_id,
      field_key: field.field_key,
      field_value: field.field_value,
      confidence: Number(field.confidence),
      extracted_at: field.extracted_at,
    })
  );
  if (isEmailCase && displayedExtractedFields.length === 0) {
    const fallbackEmail = await getLatestEmailText(tenantId, id);
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

  const fieldValues = new Map(
    displayedExtractedFields.map((field) => [field.field_key, field.field_value])
  );
  const fieldConfidences = displayedExtractedFields
    .map((field) => field.confidence)
    .filter((confidence): confidence is number => typeof confidence === "number");
  const displayedPolicyholderName =
    caseRow.policyholder_name ?? fieldValues.get("full_name") ?? null;
  const displayedPolicyNumber =
    caseRow.policy_number ?? fieldValues.get("policy_number") ?? null;
  const caseConfidenceMin =
    caseRow.confidence_min != null ? Number(caseRow.confidence_min) : null;
  const displayedConfidence =
    caseConfidenceMin ??
    (fieldConfidences.length > 0 ? Math.min(...fieldConfidences) : null);
  const caseNumber = formatCaseNumber(caseRow.id);
  const CHANNEL_LABELS: Record<string, string> = {
    email: t("channel.email"),
    email_sim: t("channel.email_sim"),
    whatsapp: t("channel.whatsapp"),
    whatsapp_sim: t("channel.whatsapp_sim"),
  };
  const channelLabel = CHANNEL_LABELS[caseRow.channel] ?? caseRow.channel;

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
                {caseRow.claim_type ? (CLAIM_TYPE_LABELS[caseRow.claim_type as ClaimType] ?? caseRow.claim_type) : "—"}
              </span>
              <StatusBadge status={caseRow.status as CaseStatus} />
            </div>

            {/* Meta info row */}
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-500">
              <span>
                <span className="font-medium text-slate-700">
                  {t("case.detail.assignedTo")}:
                </span>{" "}
                {caseRow.assigned_to ? t("case.detail.assigned") : t("case.detail.unassigned")}
              </span>
              <span>
                <span className="font-medium text-slate-700">{t("case.detail.created")}:</span>{" "}
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
                  {displayedPolicyholderName ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("case.detail.policyNumber")}</dt>
                <dd className="mt-0.5 font-mono text-slate-900">
                  {displayedPolicyNumber ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("case.detail.channel")}</dt>
                <dd className="mt-0.5 text-slate-900">
                  {channelLabel}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("case.detail.confidence.col")}</dt>
                <dd className="mt-0.5 text-slate-900">
                  {displayedConfidence != null
                    ? `${Math.round(displayedConfidence * 100)}%`
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

          {/* Análisis del agente — live preview (extracted JSON, trainability, download) */}
          <section
            aria-labelledby="agent-run-heading"
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <h2
              id="agent-run-heading"
              className="text-sm font-semibold text-slate-900 mb-4"
            >
              {t("case.detail.agentAnalysis")}
            </h2>
            <AgentRunPanel
              caseId={caseRow.id}
              canConfirmTraining={canConfirmTraining}
            />
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
                      {caseRow.is_claim === true
                        ? t("common.yes")
                        : caseRow.is_claim === false
                        ? t("common.no")
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{t("case.detail.severity")}</dt>
                    <dd className="mt-0.5">
                      {caseRow.severity ? (
                        <SeverityBadge severity={caseRow.severity} />
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </dd>
                  </div>
                  {caseRow.customer_id && (
                    <div>
                      <dt className="text-slate-500">{t("case.detail.customer")}</dt>
                      <dd className="mt-0.5">
                        <Link
                          href={`/clientes/${caseRow.customer_id}`}
                          className="text-blue-600 hover:underline font-medium text-sm"
                        >
                          {t("clientes.detail.viewClient")}
                        </Link>
                      </dd>
                    </div>
                  )}
                  {caseRow.policy_id && (
                    <div>
                      <dt className="text-slate-500">{t("case.detail.policy")}</dt>
                      <dd className="mt-0.5 font-mono text-slate-800">
                        {displayedPolicyNumber ?? t("case.detail.linked")}
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
                      {confirmations.filter((c) => c.status === "pending").length} {t("case.detail.pendingCount")}
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
              {caseRow.status === "listo_para_core" && (
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
                    {t("case.detail.coreReadyDescription")}
                  </p>
                  <CoreSyncButton
                    caseId={caseRow.id}
                    currentStatus={caseRow.status}
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

  let messages: { body: string; subject: string | null; received_at: string }[] =
    await db
      .select({ body: rawMessages.body, subject: rawMessages.subject, received_at: rawMessages.received_at })
      .from(rawMessages)
      .where(eq(rawMessages.case_id, caseId))
      .orderBy(asc(rawMessages.received_at))
      .limit(5);

  if (messages.length === 0) {
    const fallback = await db
      .select({ body_text: claimMessages.body_text, subject: claimMessages.subject, received_at: claimMessages.received_at })
      .from(claimMessages)
      .where(and(eq(claimMessages.case_id, caseId), eq(claimMessages.direction, "inbound")))
      .orderBy(asc(claimMessages.received_at))
      .limit(5);

    messages = fallback.map((msg) => ({
      body: msg.body_text ?? "",
      subject: msg.subject,
      received_at: msg.received_at,
    }));
  }

  if (!messages || messages.length === 0) {
    return (
      <p className="text-sm text-slate-400">{t("case.detail.noRawEmail")}</p>
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
                  ? `${t("messages.thread.subject")}: ${msg.subject}`
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
  _tenantId: string,
  caseId: string
): Promise<{ subject: string; body: string; senderEmail: string }> {
  const rawMsg = await db
    .select({ body: rawMessages.body, subject: rawMessages.subject, from_addr: rawMessages.from_addr })
    .from(rawMessages)
    .where(eq(rawMessages.case_id, caseId))
    .orderBy(desc(rawMessages.received_at))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (rawMsg) {
    return {
      subject: rawMsg.subject ?? "",
      body: rawMsg.body ?? "",
      senderEmail: rawMsg.from_addr ?? "",
    };
  }

  const claimMsg = await db
    .select({ body_text: claimMessages.body_text, subject: claimMessages.subject, from_addr: claimMessages.from_addr })
    .from(claimMessages)
    .where(and(eq(claimMessages.case_id, caseId), eq(claimMessages.direction, "inbound")))
    .orderBy(desc(claimMessages.received_at))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return {
    subject: claimMsg?.subject ?? "",
    body: claimMsg?.body_text ?? "",
    senderEmail: claimMsg?.from_addr ?? "",
  };
}
