/**
 * DashboardClient — interactive client component for the bandeja page.
 *
 * Responsibilities:
 *   - Renders FilterTabs, TypeFilterChips, CasesTable, Pagination
 *   - Subscribes to Supabase Realtime for live updates (AC12)
 *   - Manages the SimulateModal state (AC13)
 *   - Manages toast notifications
 *   - Handles URL search params for deep-linkable filter/page state
 *
 * Initial data is fetched server-side in page.tsx and passed as props.
 * Realtime updates merge into local state without full page reloads.
 */

"use client";

import { useState, useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { FilterTabs } from "./components/FilterTabs";
import { TypeFilterChips } from "./components/TypeFilterChips";
import {
  ChannelFilterChips,
  SeverityFilterChips,
  IsClaimFilterChips,
} from "./components/EmailFilterChips";
import { CasesTable } from "./components/CasesTable";
import { SimulateModal } from "./components/SimulateModal";
import { ToastContainer, useToast } from "./components/Toast";
import {
  useCasesRealtime,
  mergeCaseUpdate,
  computeStatusCounts,
  formatCaseNumber,
} from "./components/useCasesRealtime";
import type { CaseRow, CaseListResult } from "@/server/cases/list";
import type { SimulationScenario } from "@/server/intake/scenarios";
import type { CaseStatus, ClaimType, Severity } from "@/lib/schemas/cases";
import { useT } from "@/lib/i18n/LocaleContext";

interface PaginationProps {
  page: number;
  perPage: number;
  total: number;
  onPageChange: (page: number) => void;
}

function Pagination({ page, perPage, total, onPageChange }: PaginationProps) {
  const t = useT();
  const from = (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, total);

  return (
    <div className="flex items-center justify-between pt-4 border-t border-slate-100">
      <p className="text-sm text-slate-500">
        Mostrando {from}–{to} de {total} siniestros
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Página anterior"
        >
          {t("pagination.previous")}
        </button>
        <span className="text-sm text-slate-500">
          {page} / {Math.max(1, Math.ceil(total / perPage))}
        </span>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={to >= total}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Página siguiente"
        >
          {t("pagination.next")}
        </button>
      </div>
    </div>
  );
}

interface DashboardClientProps {
  initialData: CaseListResult;
  scenarios: SimulationScenario[];
  /** All-cases count map for status tabs (fetched server-side without status filter) */
  allStatusCounts: { status: CaseStatus | "todos"; count: number }[];
}

export function DashboardClient({
  initialData,
  scenarios,
  allStatusCounts,
}: DashboardClientProps) {
  const t = useT();
  const searchParams = useSearchParams();
  const activeStatus = (searchParams.get("status") as CaseStatus) || undefined;
  const activeType = (searchParams.get("type") as ClaimType) || undefined;
  const activePage = parseInt(searchParams.get("page") ?? "1", 10) || 1;
  // Email-intake filters (AC18)
  const activeChannel =
    (searchParams.get("channel") as "email" | "email_sim") || undefined;
  const activeSeverity = (searchParams.get("severity") as Severity) || undefined;
  const activeIsClaimRaw = searchParams.get("is_claim") as "true" | "false" | null;
  const activeIsClaim = activeIsClaimRaw ?? undefined;

  // Local cases state — starts from server-fetched data, updated by realtime.
  const [cases, setCases] = useState<CaseRow[]>(initialData.data);
  const [total, setTotal] = useState(initialData.meta.total);

  // Status counts for tabs — starts from server-fetched allStatusCounts, updated by realtime.
  const [statusCountsBase, setStatusCountsBase] = useState(allStatusCounts);

  // Sync cases whenever server re-fetches (URL param changes trigger page.tsx re-render).
  // Sync cases when server re-fetches (URL param changes trigger page.tsx re-render).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- server-driven state sync, not a cascade risk
    setCases(initialData.data);
     
    setTotal(initialData.meta.total);
  }, [initialData]);

  const { toasts, addToast, dismissToast } = useToast();
  const [showSimulateModal, setShowSimulateModal] = useState(false);

  // Realtime handlers
  const handleInsert = useCallback(
    (newCase: CaseRow) => {
      setCases((prev) => mergeCaseUpdate(prev, newCase, "insert"));
      setTotal((prev) => prev + 1);
      // Update status counts
      setStatusCountsBase((prev) => {
        const updated = prev.map((item) => {
          if (item.status === "todos") return { ...item, count: item.count + 1 };
          if (item.status === newCase.status) return { ...item, count: item.count + 1 };
          return item;
        });
        return updated;
      });
      addToast(
        `Nuevo siniestro recibido: ${formatCaseNumber(newCase.id)}`,
        "info"
      );
    },
    [addToast]
  );

  const handleUpdate = useCallback(
    (updatedCase: CaseRow, prevStatus: CaseStatus | null) => {
      setCases((prev) => mergeCaseUpdate(prev, updatedCase, "update"));
      // Update status counts when status changes
      if (prevStatus && prevStatus !== updatedCase.status) {
        setStatusCountsBase((prev) => {
          return prev.map((item) => {
            if (item.status === prevStatus) return { ...item, count: Math.max(0, item.count - 1) };
            if (item.status === updatedCase.status) return { ...item, count: item.count + 1 };
            return item;
          });
        });
        const prevLabel = prevStatus.charAt(0).toUpperCase() + prevStatus.slice(1);
        const newLabel = updatedCase.status.charAt(0).toUpperCase() + updatedCase.status.slice(1);
        addToast(
          `Siniestro ${formatCaseNumber(updatedCase.id)} actualizado: ${prevLabel} → ${newLabel}`,
          "info"
        );
      }
    },
    [addToast]
  );

  useCasesRealtime({ onInsert: handleInsert, onUpdate: handleUpdate });

  const handleDeleteCase = useCallback(
    async (caseId: string) => {
      const res = await fetch(`/api/cases/${caseId}`, { method: "DELETE" });
      if (res.ok) {
        setCases((prev) => prev.filter((c) => c.id !== caseId));
        setTotal((prev) => Math.max(0, prev - 1));
        addToast(t("bandeja.deleteSuccess"), "success");
      } else {
        addToast(t("error.generic"), "error");
      }
    },
    [addToast, t]
  );

  // Filter cases for display based on active filters
  const filteredCases = cases.filter((c) => {
    if (activeStatus && c.status !== activeStatus) return false;
    if (activeType && c.claim_type !== activeType) return false;
    // Email-intake filters (AC18)
    if (activeChannel && (c as any).channel !== activeChannel) return false;
    if (activeSeverity && (c as any).severity !== activeSeverity) return false;
    if (activeIsClaim === "true" && (c as any).is_claim !== true) return false;
    if (activeIsClaim === "false" && (c as any).is_claim !== false) return false;
    return true;
  });

  // Paginate locally (since realtime may add new cases beyond server page)
  const PER_PAGE = initialData.meta.per_page;
  const paginatedCases = filteredCases.slice(
    (activePage - 1) * PER_PAGE,
    activePage * PER_PAGE
  );
  const filteredTotal = filteredCases.length;

  function handlePageChange(newPage: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(newPage));
    window.history.pushState(null, "", `?${params.toString()}`);
    // Force a re-read of searchParams by dispatching popstate equivalent.
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  // Compute status counts from current visible cases (realtime-aware)
  const realtimeCounts = computeStatusCounts(cases);
  const tabCounts = statusCountsBase.map((item) => {
    const realtimeCount = realtimeCounts.get(item.status);
    return {
      status: item.status,
      count: realtimeCount !== undefined ? realtimeCount : item.count,
    };
  });

  return (
    <>
      <div className="flex flex-col h-full">
        {/* Page header */}
        <div className="border-b border-slate-200 bg-white px-6 py-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-semibold text-slate-900">
                Bandeja de siniestros
              </h1>
              <p className="text-sm text-slate-500 mt-0.5">
                Gestioná y filtrá los siniestros FNOL del sistema
              </p>
            </div>
            <div className="flex items-center gap-3">
              {/* CSV Export */}
              <a
                href={`/api/cases/export.csv${activeStatus || activeType ? "?" + new URLSearchParams({ ...(activeStatus ? { status: activeStatus } : {}), ...(activeType ? { type: activeType } : {}) }).toString() : ""}`}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                aria-label={t("bandeja.export")}
              >
                {t("bandeja.export")}
              </a>
              {/* Simulate button */}
              <button
                type="button"
                onClick={() => setShowSimulateModal(true)}
                data-testid="simulate-button"
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 transition-colors"
              >
                {t("bandeja.simulate")}
              </button>
            </div>
          </div>

          {/* Status filter tabs */}
          <FilterTabs counts={tabCounts} activeStatus={activeStatus} />
        </div>

        {/* Type filter chips */}
        <div className="border-b border-slate-100 bg-white px-6 py-3">
          <TypeFilterChips activeType={activeType} />
        </div>

        {/* Email-intake filter chips — channel, severity, is_claim (AC18) */}
        <div className="border-b border-slate-100 bg-white px-6 py-2 flex flex-wrap items-center gap-x-6 gap-y-2">
          <ChannelFilterChips activeChannel={activeChannel} />
          <SeverityFilterChips activeSeverity={activeSeverity} />
          <IsClaimFilterChips activeIsClaim={activeIsClaim} />
        </div>

        {/* Cases table */}
        <div className="flex-1 overflow-auto px-6 py-4">
          <CasesTable cases={paginatedCases} onDelete={handleDeleteCase} />

          {/* Pagination */}
          {filteredTotal > 0 && (
            <Pagination
              page={activePage}
              perPage={PER_PAGE}
              total={filteredTotal}
              onPageChange={handlePageChange}
            />
          )}
        </div>
      </div>

      {/* Simulate modal */}
      {showSimulateModal && (
        <SimulateModal
          scenarios={scenarios}
          onClose={() => setShowSimulateModal(false)}
          onSuccess={(msg) => addToast(msg, "success")}
          onError={(msg) => addToast(msg, "error")}
        />
      )}

      {/* Toast notifications */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
