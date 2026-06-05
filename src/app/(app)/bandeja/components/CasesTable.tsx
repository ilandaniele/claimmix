/**
 * CasesTable — @tanstack/react-table implementation for the analyst dashboard.
 *
 * Columns per AC11:
 *   Nro. Siniestro | Asegurado | Póliza | Tipo | Estado | Confianza | Hace | Analista
 *
 * Design: horizontal rules only, no vertical borders, clean and information-dense.
 * Row click navigates to /dashboard/cases/:id (case detail — W6).
 */

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table";
import type { CaseRow } from "@/server/cases/list";
import { StatusBadge } from "./StatusBadge";
import { SeverityBadge } from "./SeverityBadge";
import { SourceBadge } from "./SourceBadge";
import { ConfidenceBar } from "./ConfidenceBar";
import { formatAge } from "@/lib/utils";
import { useT } from "@/lib/i18n/LocaleContext";
import type { CaseStatus, ClaimType, Severity } from "@/lib/schemas/cases";

/** Format a case ID as a short SIN-XXXX display string */
function formatCaseId(id: string): string {
  const suffix = id.replace(/-/g, "").slice(-8).toUpperCase();
  return `SIN-${suffix.slice(0, 4)}-${suffix.slice(4)}`;
}

interface CasesTableProps {
  cases: CaseRow[];
  onDelete?: (caseId: string) => Promise<void>;
}

export function CasesTable({ cases, onDelete }: CasesTableProps) {
  const t = useT();
  const router = useRouter();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  /** Map claim type to display label */
  const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
    choque: t("type.choque"),
    robo: t("type.robo"),
    granizo: t("type.granizo"),
    incendio: t("type.incendio"),
    other: t("type.other"),
  };

  const columns = useMemo<ColumnDef<CaseRow>[]>(
    () => [
      {
        accessorKey: "id",
        header: t("table.col.id"),
        cell: ({ getValue }) => (
          <span className="font-mono text-xs text-slate-700">
            {formatCaseId(getValue<string>())}
          </span>
        ),
      },
      {
        accessorKey: "policyholder_name",
        header: t("table.col.policyholder"),
        cell: ({ getValue }) => (
          <span className="text-sm text-slate-900 font-medium">
            {getValue<string | null>() ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "policy_number",
        header: t("table.col.policy"),
        cell: ({ getValue }) => (
          <span className="text-sm text-slate-600 font-mono">
            {getValue<string | null>() ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "claim_type",
        header: t("table.col.type"),
        cell: ({ getValue }) => {
          const type = getValue<ClaimType>();
          return (
            <span className="text-sm text-slate-700">
              {CLAIM_TYPE_LABELS[type] ?? type}
            </span>
          );
        },
      },
      {
        // AC15-AC18: Provider source badge ("Fuente" column)
        accessorKey: "channel",
        header: t("table.col.source"),
        cell: ({ getValue }) => <SourceBadge channel={getValue<string | null>()} />,
      },
      {
        accessorKey: "status",
        header: t("table.col.status"),
        cell: ({ getValue }) => (
          <StatusBadge status={getValue<CaseStatus>()} />
        ),
      },
      {
        accessorKey: "confidence_min",
        header: t("table.col.confidence"),
        cell: ({ getValue }) => (
          <ConfidenceBar value={getValue<number | null>()} />
        ),
      },
      {
        accessorKey: "created_at",
        header: t("table.col.age"),
        cell: ({ getValue }) => (
          <span className="text-sm text-slate-500">
            {formatAge(getValue<string>())}
          </span>
        ),
      },
      {
        accessorKey: "severity",
        header: t("case.detail.severity"),
        cell: ({ getValue }) => {
          const severity = getValue<Severity | null>();
          return severity ? (
            <SeverityBadge severity={severity} />
          ) : (
            <span className="text-slate-300 text-xs">—</span>
          );
        },
      },
      {
        accessorKey: "assigned_to",
        header: t("table.col.assignedTo"),
        cell: ({ getValue }) => (
          <span className="text-sm text-slate-500">
            {getValue<string | null>() ? "Asignado" : "—"}
          </span>
        ),
      },
      ...(onDelete
        ? [
            {
              id: "actions",
              header: "",
              cell: ({ row }: { row: { original: CaseRow } }) => {
                const id = row.original.id;
                const isConfirming = confirmingId === id;
                const isDeleting = deletingId === id;

                if (isConfirming) {
                  return (
                    <div
                      className="flex items-center gap-1"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        disabled={isDeleting}
                        onClick={async (e) => {
                          e.stopPropagation();
                          setDeletingId(id);
                          await onDelete(id);
                          setDeletingId(null);
                          setConfirmingId(null);
                        }}
                        className="rounded px-2 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors"
                        aria-label="Confirmar eliminación"
                      >
                        {isDeleting ? "..." : t("bandeja.deleteConfirm")}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingId(null);
                        }}
                        className="rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"
                        aria-label="Cancelar"
                      >
                        {t("bandeja.deleteCancel")}
                      </button>
                    </div>
                  );
                }

                return (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmingId(id);
                    }}
                    className="rounded p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
                    aria-label={t("bandeja.delete")}
                    title={t("bandeja.delete")}
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
                        d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                );
              },
            } as ColumnDef<CaseRow>,
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, onDelete, confirmingId, deletingId]
  );

  const table = useReactTable({
    data: cases,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (cases.length === 0) {
    return (
      <div className="py-16 text-center text-sm text-slate-500" role="status">
        No hay siniestros que coincidan con los filtros.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto" role="region" aria-label="Tabla de siniestros">
      <table className="w-full table-auto text-left" aria-label="Siniestros">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  scope="col"
                  className="border-b border-slate-200 pb-3 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-500 px-3 first:pl-0 last:pr-0"
                >
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext()
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              onClick={() =>
                router.push(`/casos/${row.original.id}`)
              }
              className="group cursor-pointer border-b border-slate-100 hover:bg-slate-50 transition-colors"
              role="row"
              aria-label={`Siniestro ${formatCaseId(row.original.id)}`}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  router.push(`/casos/${row.original.id}`);
                }
              }}
            >
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  className="py-3 px-3 first:pl-0 last:pr-0"
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
