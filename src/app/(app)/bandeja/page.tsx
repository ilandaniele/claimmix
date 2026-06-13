/**
 * Bandeja page — Server Component.
 *
 * AC11: Fetches initial case data, status counts, and scenarios server-side.
 *       Passes to DashboardClient which handles realtime, filters, and interactivity.
 *
 * URL search params supported:
 *   status: CaseStatus (filter tab)
 *   type:   ClaimType  (filter chip)
 *   page:   number     (pagination)
 *
 * Protected by proxy.ts — unauthenticated access redirects to /login.
 */

import { Suspense } from "react";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getSessionContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { countRows, firstRow } from "@/lib/db/helpers";
import { cases, users } from "@/lib/db/schema";
import { listCases } from "@/server/cases/list";
import { SCENARIOS } from "@/server/intake/scenarios";
import { DashboardClient } from "./DashboardClient";
import type { CaseStatus, ClaimType, Severity } from "@/lib/schemas/cases";

const VALID_STATUSES: CaseStatus[] = [
  "procesando",
  "listo",
  "esperando",
  "escalado",
  "cerrado",
  "recibido",
  "info_faltante",
  "confirmacion_pendiente",
  "requiere_especialista",
  "listo_para_core",
  "enviado_a_core",
  "error_core",
  "no_relevante",
];
const VALID_TYPES: ClaimType[] = ["choque", "robo", "granizo", "incendio"];
const VALID_SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];
const VALID_CHANNELS = ["email_sim", "email", "whatsapp_sim", "whatsapp"] as const;

interface BandejaPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

async function BandejaContent({ searchParams }: BandejaPageProps) {
  const params = await searchParams;

  const statusParam = params["status"];
  const typeParam = params["type"];
  const pageParam = params["page"];
  const channelParam = params["channel"];
  const severityParam = params["severity"];
  const isClaimParam = params["is_claim"];

  const status =
    typeof statusParam === "string" &&
    VALID_STATUSES.includes(statusParam as CaseStatus)
      ? (statusParam as CaseStatus)
      : undefined;

  const type =
    typeof typeParam === "string" &&
    VALID_TYPES.includes(typeParam as ClaimType)
      ? (typeParam as ClaimType)
      : undefined;

  const page =
    typeof pageParam === "string" ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;

  const channel =
    typeof channelParam === "string" &&
    (VALID_CHANNELS as readonly string[]).includes(channelParam)
      ? (channelParam as typeof VALID_CHANNELS[number])
      : undefined;

  const severity =
    typeof severityParam === "string" &&
    VALID_SEVERITIES.includes(severityParam as Severity)
      ? (severityParam as Severity)
      : undefined;

  const is_claim =
    isClaimParam === "true" ? true : isClaimParam === "false" ? false : undefined;

  // Resolve the tenant boundary (RLS is gone — explicit tenant_id filter only).
  const session = await getSessionContext();
  if (!session?.user) redirect("/login");
  const userRow = firstRow(
    await db
      .select({ tenant_id: users.tenant_id })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)
  );
  if (!userRow) redirect("/login");
  const tenantId = userRow.tenant_id;

  // Fetch cases matching the current filter.
  const initialData = await listCases(tenantId, {
    status,
    type,
    page,
    per_page: 20,
    sort: "created_at",
    order: "desc",
    // Email-intake filters (AC18)
    channel,
    severity,
    is_claim,
  });

  // Fetch counts for all statuses in parallel (tenant-scoped).
  const [totalCount, ...statusCounts] = await Promise.all([
    countRows(cases, eq(cases.tenant_id, tenantId)),
    ...VALID_STATUSES.map((s) =>
      countRows(cases, and(eq(cases.tenant_id, tenantId), eq(cases.status, s)))
    ),
  ]);

  const allStatusCounts: { status: CaseStatus | "todos"; count: number }[] = [
    { status: "todos", count: totalCount },
    ...VALID_STATUSES.map((s, i) => ({
      status: s,
      count: statusCounts[i],
    })),
  ];

  return (
    <DashboardClient
      initialData={initialData}
      scenarios={SCENARIOS}
      allStatusCounts={allStatusCounts}
    />
  );
}

function BandejaLoading() {
  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="h-7 w-48 bg-slate-200 rounded animate-pulse mb-4" />
        <div className="flex gap-2">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-8 w-20 bg-slate-100 rounded animate-pulse" />
          ))}
        </div>
      </div>
      <div className="px-6 py-3 border-b border-slate-100">
        <div className="flex gap-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-7 w-16 bg-slate-100 rounded-full animate-pulse" />
          ))}
        </div>
      </div>
      <div className="px-6 py-4">
        <div className="space-y-3">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-12 bg-slate-50 rounded animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function BandejaPage(props: BandejaPageProps) {
  return (
    <Suspense fallback={<BandejaLoading />}>
      <BandejaContent {...props} />
    </Suspense>
  );
}
