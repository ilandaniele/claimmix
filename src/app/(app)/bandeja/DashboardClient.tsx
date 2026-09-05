"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { PER_PAGE_OPTIONS } from "./per-page";
import { FilterTabs } from "./components/FilterTabs";
import { usePaginacion } from "./components/useFilterParam";
import { NavegacionPendienteProvider, useNavegacion } from "./components/navegacion-pendiente";
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
import { CardHeader } from "../_components/ui";

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
  /*
   * El desplegable muestra lo elegido en el mismo instante del cambio.
   * `perPage` ya viene del destino en vuelo, pero un `<select>` controlado
   * vuelve a su `value` hasta el proximo render: sin esto, en un enlace
   * lento se veia saltar a 100 y volver a 20 por un momento.
   */
  const [elegido, setElegido] = useState(perPage);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setElegido(perPage);
  }, [perPage]);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(page, totalPages);
  const from = total === 0 ? 0 : (current - 1) * perPage + 1;
  const to = Math.min(current * perPage, total);

  const navBtn =
    "rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex flex-shrink-0 flex-col gap-3 border-t border-slate-100 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <p className="text-[13px] text-slate-500">
          {t("bandeja.showing")} {from}-{to} {t("pagination.of")} {total} {t("bandeja.claims")}
        </p>
        <label className="flex items-center gap-1.5 text-[13px] text-slate-500">
          <span className="sr-only sm:not-sr-only">{t("pagination.perPage")}</span>
          <select
            value={elegido}
            onChange={(e) => {
              const n = Number(e.target.value);
              setElegido(n);
              onPerPageChange(n);
            }}
            aria-label={t("pagination.perPage")}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[13px] text-slate-700 hover:border-slate-300 focus:border-violet-400 focus:outline-none"
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
                  ? "cifra rounded-lg bg-violet-600 px-2.5 py-1.5 text-[13px] font-semibold text-white"
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

function DashboardClientInterno({
  initialData,
  scenarios,
  allStatusCounts,
}: DashboardClientProps) {
  const t = useT();
  const searchParams = useSearchParams();
  /*
   * Lo activo se lee de `paramsVisibles`: el destino mientras la navegacion
   * esta en vuelo, la URL cuando no. Asi la pestaña, el chip y la pagina se
   * resaltan al instante del click y no cuando el servidor contesta.
   * `exportQuery`, mas abajo, sigue leyendo la URL real: el CSV es de lo que
   * ya se esta mirando, no de lo que esta por llegar.
   */
  const { pending, paramsVisibles } = useNavegacion();
  const activeStatus = (paramsVisibles.get("status") as CaseStatus) || undefined;
  const activeType = (paramsVisibles.get("type") as ClaimType) || undefined;

  // Lo que va al CSV: todo lo que filtra la pantalla, sin la paginación.
  const exportQuery = (() => {
    const p = new URLSearchParams(searchParams.toString());
    p.delete("page");
    p.delete("per_page");
    return p.toString();
  })();
  const activePage = parseInt(paramsVisibles.get("page") ?? "1", 10) || 1;
  const activeChannel =
    (paramsVisibles.get("channel") as "email" | "email_sim") || undefined;
  const activeSeverity = (paramsVisibles.get("severity") as Severity) || undefined;
  const activeIsClaimRaw = paramsVisibles.get("is_claim") as "true" | "false" | null;
  const activeIsClaim = activeIsClaimRaw ?? undefined;

  const [seleccionando, setSeleccionando] = useState(false);
  const onDeleteManyDisponible = true;
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

        /*
         * Un pedido, no uno por caso.
         *
         * Esto mandaba un DELETE por id. Con la página de cien eso se comía el
         * cupo del minuto entero —la API permite cien— y con cualquier borrado
         * previo parte de la tanda volvía 429: el usuario veía «se borraron 62
         * de 100» sin ninguna razón visible.
         *
         * El servidor responde con los ids que de verdad borró, así que el
         * manejo de borrado parcial de abajo sigue igual: ahora el parcial es
         * real (un caso que ya no estaba) y no un efecto del límite de tráfico.
         */
        const res = await fetch("/api/cases", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        });
        // `ok()` responde con el dato pelado, no envuelto en `data`.
        const cuerpo = (await res.json().catch(() => null)) as
          | { deleted?: string[] }
          | null;
        const deletedIds = res.ok ? (cuerpo?.deleted ?? []) : [];
        const failedCount = ids.length - deletedIds.length;

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
  const PER_PAGE = parseInt(paramsVisibles.get("per_page") ?? "", 10) || initialData.meta.per_page;
  const visibleCases = cases.filter((c) => {
    if (activeStatus && c.status !== activeStatus) return false;
    if (activeType && c.claim_type !== activeType) return false;
    if (activeChannel && c.channel !== activeChannel) return false;
    if (activeSeverity && c.severity !== activeSeverity) return false;
    if (activeIsClaim === "true" && c.is_claim !== true) return false;
    if (activeIsClaim === "false" && c.is_claim !== false) return false;
    return true;
  });
  const visibleTotal = total;

  // Paginar sale del mismo módulo que filtrar, y ahí está escrito por qué son
  // dos funciones y no una: filtrar borra `page`, paginar lo pone.
  const { irAPagina: handlePageChange, cambiarTamanoDePagina: handlePerPageChange } =
    usePaginacion();

  const tabCounts = statusCountsBase;

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {/*
          * El encabezado de la tarjeta.
          *
          * Acá vivían un `<h1>` y su bajada que repetían PALABRA POR PALABRA el
          * título de la pantalla, que está tres centímetros más arriba en
          * `page.tsx`. Dos veces «Bandeja de siniestros» en la misma vista.
          *
          * Lo que va en su lugar no es una etiqueta sino un dato: cuántos
          * siniestros hay bajo los filtros que están puestos ahora. Es la
          * pregunta que uno se hace después de tocar un filtro, y hasta ahora
          * había que ir a buscarla al paginador del fondo.
          */}
        <CardHeader
          title={
            <span className="cifra">
              {visibleTotal} {t("bandeja.claims")}
            </span>
          }
        >
          {/*
            * El mismo boton entra y sale del modo. Antes desaparecia al entrar
            * y la unica salida quedaba dentro de la lista: apretar «Seleccionar»
            * y ver que el boton se esfuma se lee como una falla, no como un modo.
            */}
          {onDeleteManyDisponible && (
            <button
              type="button"
              aria-pressed={seleccionando}
              onClick={() => setSeleccionando((v) => !v)}
              className={
                seleccionando
                  ? "rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-slate-700"
                  : "rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
              }
            >
              {seleccionando ? t("bandeja.listo") : t("bandeja.seleccionar")}
            </button>
          )}
          <a
            /*
             * El CSV se pide con los MISMOS filtros que muestra la pantalla.
             *
             * Este href armaba el querystring con status y type elegidos a mano,
             * así que filtrar por severidad o por canal y tocar Exportar bajaba
             * un archivo que no coincidía con lo que se estaba mirando.
             *
             * Se reenvían los parámetros de la URL tal cual, menos los de
             * paginación: el export siempre trae hasta mil filas y ordenadas por
             * fecha, así que `page` y `per_page` no significan nada acá y
             * mandarlos sólo invita a que alguien los interprete.
             */
            href={`/api/cases/export.csv${exportQuery ? `?${exportQuery}` : ""}`}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
            aria-label={t("bandeja.export")}
          >
            {t("bandeja.export")}
          </a>
          <button
            type="button"
            onClick={() => setShowSimulateModal(true)}
            data-testid="simulate-button"
            className="rounded-lg bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-violet-700"
          >
            {t("bandeja.simulate")}
          </button>
        </CardHeader>

        {/*
          * Los filtros: una sola franja, no tres.
          *
          * Eran tres tiras apiladas, cada una con su `border-b` y su `bg-white`
          * propio, metidas adentro de una tarjeta que ya tiene fondo y borde.
          * Tres líneas duras cruzando una tarjeta redondeada se ven como tres
          * tarjetas mal apiladas, que es de dónde venía lo de «medio fea».
          *
          * Ahora hay UNA línea —la de las pestañas, que separa el encabezado de
          * la lista— y los chips viven en la misma franja, agrupados con aire en
          * vez de con bordes. Ningún control se fue: están los mismos veinte.
          */}
        <div className="border-b border-slate-100 px-5">
          <FilterTabs counts={tabCounts} activeStatus={activeStatus} />
        </div>

        <div className="flex flex-col gap-2 border-b border-slate-100 px-5 py-3">
          <TypeFilterChips activeType={activeType} />
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <ChannelFilterChips activeChannel={activeChannel} />
            <SeverityFilterChips activeSeverity={activeSeverity} />
            <IsClaimFilterChips activeIsClaim={activeIsClaim} />
          </div>
        </div>

        {/*
          * `min-h-0` en este hijo y en el flex de arriba: sin eso un hijo de
          * flex no se encoge por debajo de su contenido, la tabla empuja la
          * tarjeta hacia abajo y el scroll aparece en la página entera en vez
          * de adentro de la lista.
          */}
        {/*
          * Mientras la navegacion esta en vuelo la lista se atenua y una barra
          * fina avanza arriba. Los controles siguen respondiendo: es la
          * pantalla vieja diciendo «ya te escuche», no un bloqueo.
          */}
        <div className="relative min-h-0 flex-1">
          {pending && (
            <div role="status" aria-live="polite" className="absolute inset-x-0 top-0 z-20">
              <div className="h-0.5 w-full overflow-hidden bg-violet-100">
                <div className="barra-espera h-full w-1/3 bg-violet-600" />
              </div>
              <span className="sr-only">{t("bandeja.actualizando")}</span>
            </div>
          )}
          <div
            className={`scroll-fino h-full overflow-auto transition-opacity ${pending ? "pointer-events-none opacity-60" : ""}`}
            data-scroll="lista"
            aria-busy={pending}
          >
            <CasesTable
              cases={visibleCases}
              onDeleteMany={handleDeleteMany}
              seleccionando={seleccionando}
            />
          </div>
        </div>

        {/*
          * El paginador queda FUERA del área que scrollea: antes iba al final de
          * la tabla, así que con cien filas había que bajar hasta el fondo para
          * cambiar de página. Ahora la lista se mueve y el control se queda.
          */}
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

/**
 * El proveedor de la navegacion pendiente tiene que estar POR ENCIMA de todo
 * lo que lee `useNavegacion` —incluido el propio cuerpo de la bandeja—, asi
 * que envuelve desde afuera. `page.tsx` sigue importando `DashboardClient`.
 */
export function DashboardClient(props: Parameters<typeof DashboardClientInterno>[0]) {
  return (
    <NavegacionPendienteProvider>
      <DashboardClientInterno {...props} />
    </NavegacionPendienteProvider>
  );
}
