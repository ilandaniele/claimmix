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
import { eq } from "drizzle-orm";
import { getSessionContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import type { TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { users } from "@/lib/db/schema";
import {
  cargarDetalleDeCaso,
  ultimoParaReleer,
} from "@/server/cases/detail-view";
import type { MensajeEntrante } from "@/server/cases/inbound-messages";
import { CaseDetailClient } from "./CaseDetailClient";
import { ExtractedFieldsTable } from "./components/ExtractedFieldsTable";
import { MissingDocsList } from "./components/MissingDocsList";
import { AuditTimeline } from "./components/AuditTimeline";
import { StatusBadge } from "@/app/(app)/bandeja/components/StatusBadge";
import { SeverityBadge } from "@/app/(app)/bandeja/components/SeverityBadge";
import { FieldConfirmationsPanel } from "./_components/FieldConfirmationsPanel";
import { AgentRunPanel } from "./_components/AgentRunPanel";
import { PanelSection } from "./_components/PanelSection";
import {
  FraudRiskBadge,
  InjurySeverityBadge,
} from "./_components/RiskBadges";
import { AttachmentsPanel } from "./_components/AttachmentsPanel";
import { MessagesThread } from "./_components/MessagesThread";
import { CoreSyncButton } from "./_components/CoreSyncButton";
import { Card, Field, FieldGrid, Pill } from "@/app/(app)/_components/ui";
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

export default async function CaseDetailPage({ params }: CaseDetailPageProps) {
  const { id } = await params;
  const locale = await getServerLocale();
  const t = getT(locale);

  const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
    choque: t("type.choque"),
    robo: t("type.robo"),
    granizo: t("type.granizo"),
    incendio: t("type.incendio"),
    cristales: t("type.cristales"),
    rc: t("type.rc"),
    robo_contenido: t("type.robo_contenido"),
    accidente_personal: t("type.accidente_personal"),
    other: t("type.other"),
  };

  // Resolve session + users row (tenant boundary and role gate in one lookup).
  const session = await getSessionContext();
  if (!session?.user) {
    redirect("/login");
  }
  const me = firstRow(
    // sin-inquilino: Ésta es la consulta que AVERIGUA de qué inquilino es la sesión.
    // No puede pasar por una capa que necesita el dato que ella busca.
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
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  // Este contexto es lo único que le dice de quién son los datos.
  const tenantCtx: TenantContext = { tenantId: tenantId };

  /*
   * Todo en dos esperas, no en cinco.
   *
   * Antes esta pantalla encadenaba: la fila del caso, después tres consultas
   * relacionadas, después dos de correo, después el respaldo del parser, y
   * después el acordeón —que era otro componente de servidor que consultaba
   * solo—. Cada tanda esperaba a la anterior sin necesitar nada de ella.
   *
   * Ahora: la fila del caso, y después todo lo demás junto. Sigue siendo una
   * consulta por cosa, cada una con su propio `.catch`, así que un fallo del
   * historial de auditoría no se lleva puestos los campos extraídos.
   */
  const detail = await cargarDetalleDeCaso(tenantCtx, id);

  if (!detail) {
    notFound();
  }

  // Role gate for the training confirmation button (owner/admin/specialist).
  const canConfirmTraining = ["owner", "admin", "specialist"].includes(me.role);

  const {
    case: caseRow,
    extracted_fields,
    missing_docs,
    audit_log,
    confirmations,
    attachments,
    messages,
  } = detail;

  const isEmailCase =
    caseRow.channel === "email" || caseRow.channel === "email_sim";

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
    const fallbackEmail = await ultimoParaReleer(tenantCtx, id, detail);
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
    <div className="mx-auto max-w-5xl px-6 pb-8 pt-1">
      {/* Back button */}
      <div className="mb-4">
        <Link
          href="/bandeja"
          className="-ml-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
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

      {/*
        * El encabezado del caso.
        *
        * Antes la fila de metadatos era prosa con dos puntos —«Asignado a: Sin
        * asignar   Creado: hace 3 días   18 ago 2026»— o sea etiquetas y valores
        * al mismo tamaño, en la misma línea, separados sólo por espacios. Para
        * leer un dato había que leer los tres.
        *
        * Ahora es la misma grilla de rótulo-sobre-valor que estructura el resto
        * de la pantalla: el rótulo chico y en mayúsculas, el dato abajo y en
        * tamaño de lectura. Se busca por posición, no leyendo.
        */}
      <Card className="mb-6">
        <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="mb-4 flex flex-wrap items-center gap-2.5">
              <h1 className="cifra text-[22px] font-semibold text-slate-900">
                {caseNumber}
              </h1>
              {/*
                * El tipo va en gris y el estado en su color. Los dos eran
                * insignias del mismo peso, y el tipo de siniestro —que no cambia
                * nunca— competía con el estado, que es lo único que se mira.
                */}
              <Pill>
                {caseRow.claim_type
                  ? (CLAIM_TYPE_LABELS[caseRow.claim_type as ClaimType] ??
                    caseRow.claim_type)
                  : "—"}
              </Pill>
              <StatusBadge status={caseRow.status as CaseStatus} />
            </div>

            <FieldGrid className="sm:grid-cols-3">
              <Field label={t("case.detail.assignedTo")}>
                {caseRow.assigned_to
                  ? t("case.detail.assigned")
                  : t("case.detail.unassigned")}
              </Field>
              <Field label={t("case.detail.created")}>
                {/*
                  * Dos lineas y no una separada por un punto medio: en una
                  * columna de un tercio de ancho, «Hace 14h · 31/08/2026, 09:55
                  * p. m.» se partia donde caia y dejaba un «m.» solo abajo.
                  *
                  * Apiladas ademas dicen algo: arriba lo que se lee de un
                  * vistazo —cuanto hace— y abajo el dato exacto, para cuando
                  * hace falta.
                  */}
                <span className="whitespace-nowrap">{formatAge(caseRow.created_at, t)}</span>
                {caseRow.created_at ? (
                  <span className="mt-0.5 block whitespace-nowrap text-[12.5px] text-slate-500">
                    {formatDate(caseRow.created_at)}
                  </span>
                ) : null}
              </Field>
              <Field label={t("case.detail.channel")}>{channelLabel}</Field>
            </FieldGrid>
          </div>

          {/* Action buttons — client component handles FSM state */}
          <CaseDetailClient
            caseId={caseRow.id}
            status={caseRow.status as CaseStatus}
            caseNumber={caseNumber}
          />
        </div>
      </Card>

      {/* Two-column layout: left = main content, right = docs + audit */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column — 2/3 width */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          {/* Datos del asegurado */}
          <PanelSection id="insured-data" titulo={t("case.detail.insuredData")}>
            {/*
              * El canal se fue de acá al encabezado: por dónde entró el
              * siniestro no es un dato del asegurado, y estaba ocupando el lugar
              * de uno que sí lo es.
              */}
            <FieldGrid className="sm:grid-cols-3">
              <Field label={t("case.detail.policyholderName")}>
                {displayedPolicyholderName}
              </Field>
              <Field label={t("case.detail.policyNumber")}>
                {displayedPolicyNumber ? (
                  <span className="font-mono">{displayedPolicyNumber}</span>
                ) : null}
              </Field>
              <Field label={t("case.detail.confidence.col")}>
                {displayedConfidence != null ? (
                  <span className="cifra">
                    {Math.round(displayedConfidence * 100)}%
                  </span>
                ) : null}
              </Field>
            </FieldGrid>
          </PanelSection>

          {/* Campos extraídos */}
          <PanelSection id="extracted-fields" titulo={t("case.detail.extractedFields")}>
            <ExtractedFieldsTable fields={displayedExtractedFields} />
          </PanelSection>

          {/* Análisis del agente — live preview (extracted JSON, trainability, download) */}
          <PanelSection id="agent-run" titulo={t("case.detail.agentAnalysis")}>
            <AgentRunPanel
              caseId={caseRow.id}
              canConfirmTraining={canConfirmTraining}
            />
          </PanelSection>

          {/* Texto original — collapsible accordion */}
          <PanelSection id="raw-email" titulo={t("case.detail.rawEmail")}>
            <RawEmailAccordion messages={messages} t={t} />
          </PanelSection>

          {/* Messages thread — only shown for email channel cases (AC11, AC12).
              El marco y el titulo los pone el componente: solo el sabe si hay
              mensajes, y sin ellos la tarjeta no tiene que existir. */}
          {isEmailCase && <MessagesThread caseId={caseRow.id} />}

          {/* Email-specific sections — only shown for email channel cases */}
          {isEmailCase && (
            <>
              {/* Section A: Parsed email data */}
              <PanelSection id="parsed-email" titulo={t("case.detail.parsedEmail")}>
                <FieldGrid>
                  <Field label={t("case.detail.isClaim")}>
                    {caseRow.is_claim === true
                      ? t("common.yes")
                      : caseRow.is_claim === false
                        ? t("common.no")
                        : null}
                  </Field>
                  <Field label={t("case.detail.severity")}>
                    {caseRow.severity ? (
                      <SeverityBadge severity={caseRow.severity} />
                    ) : null}
                  </Field>
                  {caseRow.customer_id && (
                    <Field label={t("case.detail.customer")}>
                      <Link
                        href={`/clientes/${caseRow.customer_id}`}
                        className="font-medium text-violet-700 hover:underline"
                      >
                        {t("clientes.detail.viewClient")}
                      </Link>
                    </Field>
                  )}
                  {caseRow.policy_id && (
                    <Field label={t("case.detail.policy")}>
                      <span className="font-mono">
                        {displayedPolicyNumber ?? t("case.detail.linked")}
                      </span>
                    </Field>
                  )}
                  {caseRow.injury_severity && caseRow.injury_severity !== "none" && (
                    <Field label="Severidad lesiones">
                      <InjurySeverityBadge severity={caseRow.injury_severity} />
                    </Field>
                  )}
                  {attachments.length > 0 && (
                    <Field label={t("case.detail.attachments")}>
                      <span className="cifra">{attachments.length}</span>{" "}
                      {t("case.detail.attachmentCount")}
                    </Field>
                  )}
                </FieldGrid>
              </PanelSection>

              {/* Análisis de fraude — solo cuando hay indicadores */}
              {caseRow.fraud_risk_level && caseRow.fraud_risk_level !== "none" && (
                <PanelSection
                  id="fraud-analysis"
                  tono={
                    caseRow.fraud_risk_level === "high"
                      ? "peligro"
                      : caseRow.fraud_risk_level === "medium"
                        ? "precaucion"
                        : "atencion"
                  }
                  titulo="Alertas de fraude"
                  accesorio={<FraudRiskBadge level={caseRow.fraud_risk_level} />}
                >
                  <p className="mb-3 text-[12px] text-slate-500 dark:text-slate-400">
                    Análisis automático — solo orientativo. La decisión final la toma el ajustador.
                  </p>
                  {Array.isArray(caseRow.fraud_indicators) && caseRow.fraud_indicators.length > 0 ? (
                    <ul className="space-y-2">
                      {(caseRow.fraud_indicators as Array<{ type: string; description: string }>).map(
                        (indicator, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm">
                            <span className={`mt-0.5 shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 font-mono text-[11px] ${
                              caseRow.fraud_risk_level === "high"
                                ? "bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-200"
                                : "bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200"
                            }`}>
                              {indicator.type.replace(/_/g, " ")}
                            </span>
                            <span className="text-slate-700 dark:text-slate-300">{indicator.description}</span>
                          </li>
                        )
                      )}
                    </ul>
                  ) : (
                    <p className="text-sm text-slate-500">Sin detalles adicionales.</p>
                  )}
                </PanelSection>
              )}

              {/* Section B: Field confirmations panel (AC21) */}
              {/*
                * El contador de pendientes pasa de estar DENTRO del título a ser
                * el accesorio de la sección.
                *
                * No es cosmético: metido en el `<h2>` formaba parte del nombre
                * accesible, así que un lector de pantalla anunciaba la sección
                * como «Confirmaciones de campos 3 pendientes» y el nombre
                * cambiaba cada vez que alguien confirmaba uno. Como accesorio se
                * ve igual y la sección conserva un nombre estable.
                */}
              <PanelSection
                id="field-confirmations"
                titulo={t("case.detail.fieldConfirmations")}
                accesorio={
                  confirmations.filter((c) => c.status === "pending").length > 0 ? (
                    <Pill tone="espera">
                      {confirmations.filter((c) => c.status === "pending").length}{" "}
                      {t("case.detail.pendingCount")}
                    </Pill>
                  ) : undefined
                }
              >
                <FieldConfirmationsPanel
                  caseId={caseRow.id}
                  initialConfirmations={confirmations}
                />
              </PanelSection>

              {/* Section C: Attachments panel (AC23) */}
              <PanelSection id="attachments" titulo={t("case.detail.attachments")}>
                <AttachmentsPanel attachments={attachments} />
              </PanelSection>

              {/* Section D: Core sync action (AC17) */}
              {caseRow.status === "listo_para_core" && (
                <PanelSection id="core-sync" tono="exito" titulo={t("case.detail.coreSyncAction")}>
                  <p className="mb-4 text-[13.5px] text-emerald-700">
                    {t("case.detail.coreReadyDescription")}
                  </p>
                  <CoreSyncButton
                    caseId={caseRow.id}
                    currentStatus={caseRow.status}
                  />
                </PanelSection>
              )}
            </>
          )}
        </div>

        {/* Right column — 1/3 width */}
        <div className="flex flex-col gap-6">
          {/* Documentación faltante */}
          <PanelSection id="missing-docs" titulo={t("case.detail.missingDocs")}>
            <MissingDocsList docs={missing_docs} />
          </PanelSection>

          {/* Historial */}
          <PanelSection id="audit-log" titulo={t("case.detail.auditLog")}>
            <AuditTimeline events={audit_log} />
          </PanelSection>
        </div>
      </div>
    </div>
  );
}

/**
 * El original de lo que escribió el asegurado, plegado.
 *
 * Recibe los mensajes por prop en vez de consultarlos.
 *
 * Los consultaba él, y eso costaba una espera entera al final del render: como
 * no hay `<Suspense>` alrededor, un componente de servidor que consulta bloquea
 * la página igual, sólo que después de todo lo demás. Ahora vienen en la misma
 * tanda que el resto y esto se limita a pintarlos.
 */
function RawEmailAccordion({
  messages,
  t,
}: {
  messages: MensajeEntrante[];
  // El diccionario baja por prop: los dos son de servidor, no hay frontera que
  // cruzar, y así el acordeón no vuelve a leer la cookie de idioma.
  t: ReturnType<typeof getT>;
}) {

  if (!messages || messages.length === 0) {
    return (
      <p className="text-[13.5px] text-slate-400">{t("case.detail.noRawEmail")}</p>
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
            className="group rounded-xl border border-slate-200"
          >
            <summary className="flex cursor-pointer select-none list-none items-center justify-between gap-3 rounded-xl px-4 py-3 text-[13.5px] font-medium text-slate-700 hover:bg-slate-50">
              <span className="min-w-0 truncate">
                {msg.subject
                  ? `${t("messages.thread.subject")}: ${msg.subject}`
                  : t("case.detail.rawEmailToggle")}
              </span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-4 w-4 flex-shrink-0 text-slate-400 transition-transform group-open:rotate-180"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
                  clipRule="evenodd"
                />
              </svg>
            </summary>
            <pre className="overflow-x-auto whitespace-pre-wrap border-t border-slate-100 px-4 pb-4 pt-3 font-mono text-[12px] leading-relaxed text-slate-600">
              {msg.body}
            </pre>
          </details>
        )
      )}
    </div>
  );
}
