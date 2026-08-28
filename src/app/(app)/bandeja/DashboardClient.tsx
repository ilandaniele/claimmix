"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  formatCaseNumber,
} from "./components/useCasesRealtime";
import type { CaseRow, CaseListResult } from "@/server/cases/list";
import type { SimulationScenario } from "@/server/intake/scenarios";
import type { CaseStatus, ClaimType, Severity } from "@/lib/schemas/cases";
import { useT } from "@/lib/i18n/LocaleContext";

const SKIP_CONFIRM_KEY = "claimmix:skip-delete-confirm";

// ── Delete confirmation dialog ────────────────────────────────────────────────

interface DeleteConfirmDialogProps {
  count: number;
  onConfirm: (remember: boolean) => void;
  onCancel: () => void;
}

function DeleteConfirmDialog({ count, onConfirm, onCancel }: DeleteConfirmDialogProps) {
  const t = useT();
  const [remember, setRemember] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-confirm-title"
    >
      <div className="w-full max-w-sm rounded-xl bg-white shadow-xl p-6 mx-4">
        {/* Icon */}
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-6 h-6 text-red-600"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z"
              clipRule="evenodd"
            />
          </svg>
        </div>

        <h2 id="delete-confirm-title" className="text-base font-semibold text-slate-900 mb-1">
          {t("bandeja.deleteConfirmTitle")}
        </h2>
        <p className="text-sm text-slate-500 mb-5">
          {count === 1
            ? t("bandeja.deleteConfirmBody1")
            : `${t("bandeja.deleteConfirmBodyN")} ${count} siniestros. ${t("bandeja.deleteConfirmIrreversible")}`}
        </p>

        {/* Remember checkbox */}
        <label className="mb-5 flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="rounded border-slate-300 text-slate-900 focus:ring-slate-500"
          />
          <span className="text-sm text-slate-600">{t("bandeja.deleteRemember")}</span>
        </label>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            {t("bandeja.deleteCancel")}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(remember)}
            className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
          >
            {t("bandeja.deleteConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Pagination ────────────────────────────────────────────────────────────────

/** Page-size options offered in the inbox. `listCases` caps per_page at 100. */
export const PER_PAGE_OPTIONS = [10, 20, 50, 100] as const;

/**
 * Page numbers to render, collapsing long ranges with ellipses so the control
 * stays one line: always first/last, plus a window around the current page.
 * e.g. 1 … 6 [7] 8 … 42
 */
function pageItems(current: number, totalPages: number): (number | "…")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const items: (number | "…")[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(totalPages - 1, current + 1);
  if (start > 2) items.push("…");
  for (let p = start; p <= end; p++) items.push(p);
  if (end < totalPages - 1) items.push("…");
  items.push(totalPages);
  return items;
}

interface PaginationProps {
  page: number;
  perPage: number;
  total: number;
  onPageChange: (page: number) => void;
  onPerPageChange: (perPage: number) => void;
}

function Pagination({ page, perPage, total, onPageChange, onPerPageChange }: PaginationProps) {
  const t = useT();
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(page, totalPages);
  const from = total === 0 ? 0 : (current - 1) * perPage + 1;
  const to = Math.min(current * perPage, total);

  const navBtn =
    "rounded-md px-2.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors";

  return (
    <div className="flex flex-col gap-3 pt-4 border-t border-slate-100 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <p className="text-sm text-slate-500">
          {t("bandeja.showing")} {from}-{to} {t("pagination.of")} {total} {t("bandeja.claims")}
        </p>
        <label className="flex items-center gap-1.5 text-sm text-slate-500">
          <span className="sr-only sm:not-sr-only">{t("pagination.perPage")}</span>
          <select
            value={perPage}
            onChange={(e) => onPerPageChange(Number(e.target.value))}
            aria-label={t("pagination.perPage")}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700 hover:border-slate-300 focus:border-slate-400 focus:outline-none"
          >
            {PER_PAGE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(1)}
          disabled={current <= 1}
          className={navBtn}
          aria-label={t("pagination.first")}
        >
          «
        </button>
        <button
          onClick={() => onPageChange(current - 1)}
          disabled={current <= 1}
          className={navBtn}
          aria-label={t("pagination.previous")}
        >
          {t("pagination.previous")}
        </button>

        {pageItems(current, totalPages).map((item, i) =>
          item === "…" ? (
            <span key={`gap-${i}`} className="px-1 text-sm text-slate-400" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={item}
              onClick={() => onPageChange(item)}
              aria-current={item === current ? "page" : undefined}
              aria-label={`${t("pagination.page")} ${item}`}
              className={
                item === current
                  ? "rounded-md bg-slate-900 px-2.5 py-1.5 text-sm font-semibold text-white"
                  : navBtn
              }
            >
              {item}
            </button>
          )
        )}

        <button
          onClick={() => onPageChange(current + 1)}
          disabled={current >= totalPages}
          className={navBtn}
          aria-label={t("pagination.next")}
        >
          {t("pagination.next")}
        </button>
        <button
          onClick={() => onPageChange(totalPages)}
          disabled={current >= totalPages}
          className={navBtn}
          aria-label={t("pagination.last")}
        >
          »
        </button>
      </div>
    </div>
  );
}

// ── DashboardClient ───────────────────────────────────────────────────────────

interface DashboardClientProps {
  initialData: CaseListResult;
  scenarios: SimulationScenario[];
  allStatusCounts: { status: CaseStatus | "todos"; count: number }[];
}

export function DashboardClient({
  initialData,
  scenarios,
  allStatusCounts,
}: DashboardClientProps) {
  const t = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeStatus = (searchParams.get("status") as CaseStatus) || undefined;
  const activeType = (searchParams.get("type") as ClaimType) || undefined;

  // Lo que va al CSV: todo lo que filtra la pantalla, sin la paginación.
  const exportQuery = (() => {
    const p = new URLSearchParams(searchParams.toString());
    p.delete("page");
    p.delete("per_page");
    return p.toString();
  })();
  const activePage = parseInt(searchParams.get("page") ?? "1", 10) || 1;
  const activeChannel =
    (searchParams.get("channel") as "email" | "email_sim") || undefined;
  const activeSeverity = (searchParams.get("severity") as Severity) || undefined;
  const activeIsClaimRaw = searchParams.get("is_claim") as "true" | "false" | null;
  const activeIsClaim = activeIsClaimRaw ?? undefined;

  const [cases, setCases] = useState<CaseRow[]>(initialData.data);
  const [total, setTotal] = useState(initialData.meta.total);
  const [statusCountsBase, setStatusCountsBase] = useState(allStatusCounts);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCases(initialData.data);
    setTotal(initialData.meta.total);
  }, [initialData]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatusCountsBase(allStatusCounts);
  }, [allStatusCounts]);

  const { toasts, addToast, dismissToast } = useToast();
  const [showSimulateModal, setShowSimulateModal] = useState(false);

  // ── Delete confirmation state ───────────────────────────────────────────────
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>([]);
  const pendingOnDoneRef = useRef<(() => void) | null>(null);

  // ── Execute actual deletes ─────────────────────────────────────────────────
  const executeDelete = useCallback(
    async (ids: string[], onDone: () => void) => {
      try {
        const deletedRows = cases.filter((c) => ids.includes(c.id));
        const results = await Promise.all(
          ids.map(async (id) => {
            const res = await fetch(`/api/cases/${id}`, { method: "DELETE" });
            return { id, ok: res.ok };
          })
        );

        const deletedIds = results.filter((result) => result.ok).map((result) => result.id);
        const failedCount = results.length - deletedIds.length;

        if (deletedIds.length > 0) {
          setCases((prev) => prev.filter((c) => !deletedIds.includes(c.id)));
          setTotal((prev) => Math.max(0, prev - deletedIds.length));
          setStatusCountsBase((prev) =>
            prev.map((item) => {
              if (item.status === "todos") {
                return { ...item, count: Math.max(0, item.count - deletedIds.length) };
              }
              const deletedForStatus = deletedRows.filter(
                (row) => row.status === item.status && deletedIds.includes(row.id)
              ).length;
              return deletedForStatus > 0
                ? { ...item, count: Math.max(0, item.count - deletedForStatus) }
                : item;
            })
          );
          addToast(
            deletedIds.length === 1
              ? t("bandeja.deleteSuccess")
              : `${deletedIds.length} ${t("bandeja.deleteManySuccess")}`,
            "success"
          );
        }

        if (failedCount > 0) {
          addToast(
            failedCount === ids.length
              ? t("bandeja.deleteError")
              : `${failedCount} ${t("bandeja.deleteManyPartial")}`,
            "error"
          );
        }

        if (failedCount === 0) {
          onDone();
        }
      } catch {
        addToast(t("bandeja.deleteError"), "error");
      }
    },
    [addToast, cases, t]
  );

  // ── Entry point called by CasesTable ──────────────────────────────────────
  const handleDeleteMany = useCallback(
    (ids: string[], onDone: () => void) => {
      const skip =
        typeof window !== "undefined" &&
        localStorage.getItem(SKIP_CONFIRM_KEY) === "true";

      if (skip) {
        executeDelete(ids, onDone);
      } else {
        pendingOnDoneRef.current = onDone;
        setPendingDeleteIds(ids);
      }
    },
    [executeDelete]
  );

  const handleConfirmDelete = useCallback(
    (remember: boolean) => {
      if (remember) {
        localStorage.setItem(SKIP_CONFIRM_KEY, "true");
      }
      const ids = pendingDeleteIds;
      const onDone = pendingOnDoneRef.current ?? (() => {});
      setPendingDeleteIds([]);
      pendingOnDoneRef.current = null;
      executeDelete(ids, onDone);
    },
    [pendingDeleteIds, executeDelete]
  );

  const handleCancelDelete = useCallback(() => {
    setPendingDeleteIds([]);
    pendingOnDoneRef.current = null;
  }, []);

  // ── Realtime handlers ──────────────────────────────────────────────────────
  const handleInsert = useCallback(
    (newCase: CaseRow) => {
      setCases((prev) => mergeCaseUpdate(prev, newCase, "insert"));
      setTotal((prev) => prev + 1);
      setStatusCountsBase((prev) =>
        prev.map((item) => {
          if (item.status === "todos") return { ...item, count: item.count + 1 };
          if (item.status === newCase.status) return { ...item, count: item.count + 1 };
          return item;
        })
      );
      addToast(`${t("bandeja.toastNew")} ${formatCaseNumber(newCase.id)}`, "info");
    },
    [addToast, t]
  );

  const handleUpdate = useCallback(
    (updatedCase: CaseRow, prevStatus: CaseStatus | null) => {
      setCases((prev) => mergeCaseUpdate(prev, updatedCase, "update"));
      if (prevStatus && prevStatus !== updatedCase.status) {
        setStatusCountsBase((prev) =>
          prev.map((item) => {
            if (item.status === prevStatus)
              return { ...item, count: Math.max(0, item.count - 1) };
            if (item.status === updatedCase.status)
              return { ...item, count: item.count + 1 };
            return item;
          })
        );
        addToast(
          `${formatCaseNumber(updatedCase.id)} ${t("bandeja.toastUpdated")} ${prevStatus} → ${updatedCase.status}`,
          "info"
        );
      }
    },
    [addToast, t]
  );

  useCasesRealtime({ onInsert: handleInsert, onUpdate: handleUpdate });

  // ── Filtering & pagination ─────────────────────────────────────────────────
  const PER_PAGE = initialData.meta.per_page;
  const visibleCases = cases.filter((c) => {
    if (activeStatus && c.status !== activeStatus) return false;
    if (activeType && c.claim_type !== activeType) return false;
    if (activeChannel && (c as any).channel !== activeChannel) return false;
    if (activeSeverity && (c as any).severity !== activeSeverity) return false;
    if (activeIsClaim === "true" && (c as any).is_claim !== true) return false;
    if (activeIsClaim === "false" && (c as any).is_claim !== false) return false;
    return true;
  });
  const visibleTotal = total;

  function handlePageChange(newPage: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(newPage));
    router.push(`/bandeja?${params.toString()}`);
  }

  function handlePerPageChange(newPerPage: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("per_page", String(newPerPage));
    // Row 1 of the new page size is always on page 1 — staying on the old page
    // number can land past the end of the shorter list.
    params.set("page", "1");
    router.push(`/bandeja?${params.toString()}`);
  }

  const tabCounts = statusCountsBase;

  return (
    <>
      <div className="flex flex-col h-full">
        {/* Page header */}
        <div className="border-b border-slate-200 bg-white px-6 py-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-semibold text-slate-900">
                {t("bandeja.title")}
              </h1>
              <p className="text-sm text-slate-500 mt-0.5">
                {t("bandeja.subtitle")}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <a
                /*
                 * El CSV se pide con los MISMOS filtros que muestra la pantalla.
                 *
                 * Este href armaba el querystring con status y type elegidos a
                 * mano, así que filtrar por severidad o por canal y tocar Exportar
                 * bajaba un archivo que no coincidía con lo que se estaba mirando.
                 *
                 * Se reenvían los parámetros de la URL tal cual, menos los de
                 * paginación: el export siempre trae hasta mil filas y ordenadas
                 * por fecha, así que `page` y `per_page` no significan nada acá y
                 * mandarlos sólo invita a que alguien los interprete.
                 */
                href={`/api/cases/export.csv${exportQuery ? `?${exportQuery}` : ""}`}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                aria-label={t("bandeja.export")}
              >
                {t("bandeja.export")}
              </a>
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
          <FilterTabs counts={tabCounts} activeStatus={activeStatus} />
        </div>

        <div className="border-b border-slate-100 bg-white px-6 py-3">
          <TypeFilterChips activeType={activeType} />
        </div>

        <div className="border-b border-slate-100 bg-white px-6 py-2 flex flex-wrap items-center gap-x-6 gap-y-2">
          <ChannelFilterChips activeChannel={activeChannel} />
          <SeverityFilterChips activeSeverity={activeSeverity} />
          <IsClaimFilterChips activeIsClaim={activeIsClaim} />
        </div>

        {/* Cases table */}
        <div className="flex-1 overflow-auto px-6 py-4">
          <CasesTable cases={visibleCases} onDeleteMany={handleDeleteMany} />

          {visibleTotal > 0 && (
            <Pagination
              page={activePage}
              perPage={PER_PAGE}
              total={visibleTotal}
              onPageChange={handlePageChange}
              onPerPageChange={handlePerPageChange}
            />
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      {pendingDeleteIds.length > 0 && (
        <DeleteConfirmDialog
          count={pendingDeleteIds.length}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      )}

      {/* Simulate modal */}
      {showSimulateModal && (
        <SimulateModal
          scenarios={scenarios}
          onClose={() => setShowSimulateModal(false)}
          onSuccess={(msg) => addToast(msg, "success")}
          onError={(msg) => addToast(msg, "error")}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
