/**
 * Bandeja page — Server Component.
 *
 * AC11: Fetches initial case data, status counts, and scenarios server-side.
 *       Passes to DashboardClient which handles realtime, filters, and interactivity.
 *
 * URL search params supported:
 *   status: CaseStatus (filter tab)
 *   type:   ClaimType  (filter chip)
 *   page:     number   (pagination)
 *   per_page: number   (page size — must be one of PER_PAGE_OPTIONS)
 *
 * Protected by proxy.ts — unauthenticated access redirects to /login.
 */

import { Suspense } from "react";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { getSessionContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { enTenant } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { cases, users } from "@/lib/db/schema";
import { listCases } from "@/server/cases/list";
import { SCENARIOS } from "@/server/intake/scenarios";
import { DashboardClient, PER_PAGE_OPTIONS } from "./DashboardClient";
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

  // Page size is user-selectable; only accept the sizes the picker offers so a
  // hand-edited URL can't ask for an unbounded page (listCases caps at 100).
  const perPageParam = params["per_page"];
  const per_page =
    typeof perPageParam === "string" &&
    (PER_PAGE_OPTIONS as readonly number[]).includes(parseInt(perPageParam, 10))
      ? parseInt(perPageParam, 10)
      : 20;

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
    // sin-inquilino: Ésta es la consulta que AVERIGUA de qué inquilino es la sesión.
    // No puede pasar por una capa que necesita el dato que ella busca.
    await db
      .select({ tenant_id: users.tenant_id })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)
  );
  if (!userRow) redirect("/login");
  const tenantId = userRow.tenant_id;

  // Fetch cases matching the current filter.
  const initialData = await listCases({ tenantId }, {
    status,
    type,
    page,
    per_page,
    sort: "created_at",
    order: "desc",
    // Email-intake filters (AC18)
    channel,
    severity,
    is_claim,
  });

  /*
   * Un solo viaje para los catorce contadores.
   *
   * Eran catorce `countRows` en un `Promise.all`: uno por estado más el total.
   * Estar en paralelo no los junta — cada `enTenant` abre su propio `batch()`
   * contra Neon con su `set_config` adelante, así que la pantalla principal
   * arrancaba con catorce transacciones HTTP en vez de una.
   *
   * No era lento por la base: hay índice `(tenant_id, status)` y cada COUNT era
   * un scan barato. Lo que se ahorra son trece viajes y trece transacciones.
   *
   * `count(*)::int` escrito a mano y no `db.$count`: eso último devuelve algo
   * que se puede esperar pero que `batch()` no puede armar, y rompió estos
   * mismos contadores en producción. Ver src/lib/db/helpers.ts.
   */
  const porEstado = await enTenant<Array<{ status: string; n: number }>>(
    { tenantId },
    (db) =>
      db
        .select({ status: cases.status, n: sql<number>`count(*)::int` })
        .from(cases)
        .groupBy(cases.status)
  );

  /*
   * El total suma TODAS las filas, no sólo las de los estados conocidos.
   *
   * `cases.status` es `text` sin CHECK ni enum: los trece valores válidos viven
   * en Zod y copiados a mano acá arriba. El `countRows` que esto reemplaza
   * contaba la tabla entera, así que un caso con un estado fuera de la lista
   * entraba igual al total. Sumar sólo lo mapeado cambiaría la tarjeta «Total
   * casos» sin que nadie se entere.
   */
  const cuenta = new Map(porEstado.map((r) => [r.status, r.n]));
  const totalCount = porEstado.reduce((acc, r) => acc + r.n, 0);

  const allStatusCounts: { status: CaseStatus | "todos"; count: number }[] = [
    { status: "todos", count: totalCount },
    // Se recorre VALID_STATUSES y no el resultado: un estado sin casos no
    // vuelve del GROUP BY, y su pestaña tiene que mostrar 0, no desaparecer.
    ...VALID_STATUSES.map((s) => ({ status: s, count: cuenta.get(s) ?? 0 })),
  ];

  const criticalCount = allStatusCounts.find(s => s.status === "escalado")?.count ?? 0;
  const pendingCount =
    (allStatusCounts.find(s => s.status === "esperando")?.count ?? 0) +
    (allStatusCounts.find(s => s.status === "info_faltante")?.count ?? 0);
  const resolvedCount =
    (allStatusCounts.find(s => s.status === "listo")?.count ?? 0) +
    (allStatusCounts.find(s => s.status === "cerrado")?.count ?? 0);

  return (
    <div className="flex flex-col h-full">
      {/* Stat cards */}
      <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800">
        <div className="grid grid-cols-4 gap-3">
          {/* Total */}
          <div className="rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 p-3">
            <p className="text-xs text-slate-500">Total casos</p>
            <p className="text-2xl font-semibold text-slate-900 dark:text-slate-100 mt-0.5">{totalCount}</p>
          </div>
          {/* Critical */}
          <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-3">
            <p className="text-xs text-red-600 dark:text-red-400">Críticos</p>
            <p className="text-2xl font-semibold text-red-700 dark:text-red-400 mt-0.5">{criticalCount}</p>
          </div>
          {/* Pending */}
          <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 p-3">
            <p className="text-xs text-amber-600 dark:text-amber-400">Pendientes</p>
            <p className="text-2xl font-semibold text-amber-700 dark:text-amber-400 mt-0.5">{pendingCount}</p>
          </div>
          {/* Resolved */}
          <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 p-3">
            <p className="text-xs text-emerald-600 dark:text-emerald-400">Resueltos</p>
            <p className="text-2xl font-semibold text-emerald-700 dark:text-emerald-400 mt-0.5">{resolvedCount}</p>
          </div>
        </div>
      </div>
      {/* Cases list */}
      <div className="flex-1 overflow-hidden">
        <DashboardClient
          initialData={initialData}
          scenarios={SCENARIOS}
          allStatusCounts={allStatusCounts}
        />
      </div>
    </div>
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
