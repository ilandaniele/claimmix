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

import { useMemo } from "react";
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
import { ConfidenceBar } from "./ConfidenceBar";
import { formatAge } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { CaseStatus, ClaimType, Severity } from "@/lib/schemas/cases";

/** Map claim type to display label */
const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
  choque: t("type.choque"),
  robo: t("type.robo"),
  granizo: t("type.granizo"),
  incendio: t("type.incendio"),
};

/** Format a case ID as a short SIN-XXXX display string */
function formatCaseId(id: string): string {
  const suffix = id.replace(/-/g, "").slice(-8).toUpperCase();
  return `SIN-${suffix.slice(0, 4)}-${suffix.slice(4)}`;
}

interface CasesTableProps {
  cases: CaseRow[];
}

export function CasesTable({ cases }: CasesTableProps) {
  const router = useRouter();

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
            Hace {formatAge(getValue<string>())}
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
    ],
    []
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
