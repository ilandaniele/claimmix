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
import { createServerClient } from "@/lib/supabase/server";
import { listCases } from "@/server/cases/list";
import { SCENARIOS } from "@/server/intake/scenarios";
import { DashboardClient } from "./DashboardClient";
import type { CaseStatus, ClaimType } from "@/lib/schemas/cases";

const VALID_STATUSES: CaseStatus[] = [
  "procesando",
  "listo",
  "esperando",
  "escalado",
  "cerrado",
];
const VALID_TYPES: ClaimType[] = ["choque", "robo", "granizo", "incendio"];

interface BandejaPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

async function BandejaContent({ searchParams }: BandejaPageProps) {
  const params = await searchParams;

  const statusParam = params["status"];
  const typeParam = params["type"];
  const pageParam = params["page"];

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

  const supabase = await createServerClient();

  // Fetch cases matching the current filter.
  const initialData = await listCases(supabase, {
    status,
    type,
    page,
    per_page: 20,
    sort: "created_at",
    order: "desc",
  });

  // Fetch counts for all statuses in parallel (was 6 sequential round-trips).
  const supabaseAny = supabase as any;

  const [totalResult, ...statusResults] = await Promise.all([
    supabaseAny.from("cases").select("id", { count: "exact", head: true }),
    ...VALID_STATUSES.map((s) =>
      supabaseAny
        .from("cases")
        .select("id", { count: "exact", head: true })
        .eq("status", s)
    ),
  ]);

  const allStatusCounts: { status: CaseStatus | "todos"; count: number }[] = [
    { status: "todos", count: totalResult.count ?? 0 },
    ...VALID_STATUSES.map((s, i) => ({
      status: s,
      count: statusResults[i].count ?? 0,
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
