"use client";

import { useMemo, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type CellContext,
  type ColumnDef,
} from "@tanstack/react-table";
import type { CaseRow } from "@/server/cases/list";
import { StatusBadge } from "./StatusBadge";
import { SeverityBadge } from "./SeverityBadge";
import { SourceBadge } from "./SourceBadge";
import { ConfidenceBar } from "./ConfidenceBar";
import { Vacio } from "./Vacio";
import { useLocale } from "@/lib/i18n/LocaleContext";
import type { CaseStatus, ClaimType, Severity } from "@/lib/schemas/cases";

function formatCaseId(id: string): string {
  const suffix = id.replace(/-/g, "").slice(-8).toUpperCase();
  return `SIN-${suffix.slice(0, 4)}-${suffix.slice(4)}`;
}

interface CasesTableProps {
  cases: CaseRow[];
  /** Modo seleccion: las filas se marcan en vez de abrirse. */
  seleccionando?: boolean;
  /**
   * Called with the IDs to delete and a callback to clear the selection
   * once the parent has finished (or started) the operation.
   */
  onDeleteMany?: (ids: string[], onDone: () => void) => void;
}

export function CasesTable({
  cases,
  onDeleteMany,
  seleccionando = false,
}: CasesTableProps) {
  const { t, locale } = useLocale();
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Entrar o salir del modo empieza de cero: lo marcado no sobrevive al «Listo».
  const [modoPrevio, setModoPrevio] = useState(seleccionando);
  if (modoPrevio !== seleccionando) {
    setModoPrevio(seleccionando);
    setSelectedIds(new Set());
  }

  const allIds = useMemo(() => cases.map((c) => c.id), [cases]);
  const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));
  const someSelected = !allSelected && selectedIds.size > 0;

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) =>
      allSelected ? new Set() : new Set(allIds)
    );
  }, [allSelected, allIds]);

  const toggleOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

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

  const columns = useMemo<ColumnDef<CaseRow>[]>(
    () => [
      /*
       * Sin recuadros. Los checkboxes cuadrados en cada fila eran veinte cajas
       * que competian con el contenido para una accion que se usa de vez en
       * cuando. La columna existe solo en modo seleccion, y el control es un
       * circulo del acento: vacio, o relleno con un tilde al marcar.
       *
       * Lo marcado se lee de `meta`, no de la clausura: si `selectedIds`
       * fuera dependencia de este memo, cada marca rearmaria las columnas y
       * `flexRender` desmontaria y volveria a montar TODAS las celdas.
       */
      ...(onDeleteMany && seleccionando
        ? [
            {
              id: "select",
              header: "",
              cell: ({ row, table }: CellContext<CaseRow, unknown>) => {
                const { selectedIds } = table.options.meta as { selectedIds: Set<string> };
                const marcado = selectedIds.has(row.original.id);
                return (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={marcado}
                    aria-label={t("bandeja.marcar").replace("{id}", formatCaseId(row.original.id))}
                    onClick={() => toggleOne(row.original.id)}
                    className={[
                      "inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 transition-colors",
                      marcado
                        ? "border-violet-600 bg-violet-600 text-white"
                        : "border-slate-300 bg-white group-hover:border-violet-400",
                    ].join(" ")}
                  >
                    {marcado && (
                      <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
                        <path d="M2.5 6.5l2.2 2.2L9.5 3.9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                );
              },
            } as ColumnDef<CaseRow>,
          ]
        : []),
      {
        accessorKey: "id",
        header: t("table.col.id"),
        cell: ({ getValue }) => (
          /*
           * `whitespace-nowrap`: «SIN-91DB-1A14» se partia en dos lineas por el
           * guion, y una tabla con la primera columna de doble altura se lee
           * como si cada fila fuera dos.
           */
          /*
           * Violeta y no gris: es el identificador de la entidad, lo que en la
           * referencia se dibuja como enlace. Es el UNICO acento de la fila —
           * el estado y la severidad llevan color semantico, no de marca.
           */
          <span className="whitespace-nowrap font-mono text-[12.5px] font-medium text-violet-700">
            {formatCaseId(getValue<string>())}
          </span>
        ),
      },
      /*
       * Asegurado y poliza en la misma celda, uno sobre el otro.
       *
       * Es el idioma de la referencia —rotulo chico sobre valor— y ademas
       * saca una columna: la poliza sola, en su propia columna mono, era un
       * codigo suelto lejos de la persona a la que pertenece. Debajo del
       * nombre se lee como lo que es, y la tabla gana aire horizontal.
       */
      {
        accessorKey: "policyholder_name",
        header: t("table.col.policyholder"),
        cell: ({ row }) => {
          const nombre = row.original.policyholder_name;
          const poliza = row.original.policy_number;
          if (!nombre && !poliza) return <Vacio />;
          return (
            <div className="min-w-0 max-w-[13rem]">
              {nombre ? (
                <span className="block truncate text-[13.5px] font-semibold text-slate-900" title={nombre}>
                  {nombre}
                </span>
              ) : (
                <Vacio />
              )}
              {poliza && (
                <span className="mt-0.5 block whitespace-nowrap font-mono text-[11.5px] text-slate-500">
                  {poliza}
                </span>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: "claim_type",
        header: t("table.col.type"),
        cell: ({ getValue }) => {
          const type = getValue<ClaimType>();
          return (
            <span className="whitespace-nowrap text-[13.5px] text-slate-700">
              {CLAIM_TYPE_LABELS[type] ?? type}
            </span>
          );
        },
      },
      {
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
        // Whether the claimant has been written back to, on whatever channel
        // they used. A claim nobody has answered is a different kind of
        // problem from one that was acknowledged and is simply waiting, and
        // until now the inbox gave no way to tell them apart.
        accessorKey: "replied_at",
        header: t("table.col.replied"),
        cell: ({ getValue, row }) => {
          const at = getValue<string | null>();

          // Non-claims are answered by design with silence, so "sin responder"
          // would read as a backlog item when it is the correct outcome.
          if (row.original.is_claim === false) {
            return <Vacio />;
          }

          if (!at) {
            return (
              <span className="inline-flex items-center whitespace-nowrap rounded-full bg-amber-50 px-2.5 py-0.5 text-[12px] font-medium text-amber-700">
                {t("table.replied.pending")}
              </span>
            );
          }

          return (
            <span
              className="inline-flex items-center whitespace-nowrap rounded-full bg-emerald-50 px-2.5 py-0.5 text-[12px] font-medium text-emerald-700"
              title={new Intl.DateTimeFormat(locale, {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(at))}
            >
              {t("table.replied.yes")}
            </span>
          );
        },
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
        header: t("table.col.received"),
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap text-[13px] text-slate-500">
            {new Intl.DateTimeFormat(locale, {
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
              /*
               * Reloj de 24 horas en castellano. `Intl` con `es-AR` devolvía
               * «09:55 p. m.» —cinco caracteres de más por fila, y con doce
               * columnas eso era lo que empujaba «Asignación» fuera de la
               * pantalla—. Además en Argentina el horario se escribe 21:55.
               *
               * En inglés se deja el formato que la persona espera.
               */
              hour12: locale.startsWith("es") ? false : undefined,
            }).format(new Date(getValue<string>()))}
          </span>
        ),
      },
      {
        accessorKey: "severity",
        header: t("case.detail.severity"),
        cell: ({ getValue }) => {
          const severity = getValue<Severity | null>();
          return severity ? <SeverityBadge severity={severity} /> : <Vacio />;
        },
      },
      {
        accessorKey: "assigned_to",
        header: t("table.col.assignedTo"),
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap text-[13px] text-slate-500">
            {getValue<string | null>() ? t("case.detail.assigned") : <Vacio />}
          </span>
        ),
      },
      ...(onDeleteMany
        ? [
            {
              id: "row-delete",
              header: "",
              cell: ({ row }: { row: { original: CaseRow } }) => (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteMany([row.original.id], () =>
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        next.delete(row.original.id);
                        return next;
                      })
                    );
                  }}
                  className="rounded p-1.5 text-slate-400 opacity-0 transition-all hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
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
              ),
            } as ColumnDef<CaseRow>,
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, onDeleteMany, seleccionando, toggleOne]
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table intentionally opts out of React Compiler memoization.
  const table = useReactTable({
    data: cases,
    columns,
    getCoreRowModel: getCoreRowModel(),
    meta: { selectedIds },
  });

  if (cases.length === 0) {
    return (
      <div className="px-5 py-20 text-center" role="status">
        <p className="text-[14px] text-slate-500">{t("bandeja.empty")}</p>
      </div>
    );
  }

  return (
    <div>
      {/*
        * La barra del modo seleccion. «Seleccionar todos» es una ACCION con
        * su numero, no una casilla en el encabezado: dice cuantas va a marcar
        * y se convierte en «Quitar seleccion» cuando ya estan todas.
        */}
      {onDeleteMany && seleccionando && (
        <div
          role="toolbar"
          aria-label={t("bandeja.seleccionar")}
          className="mx-5 mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
        >
          <span className="cifra rounded-full bg-violet-600 px-2 py-0.5 text-[12px] font-semibold text-white">
            {selectedIds.size}
          </span>
          <span className="text-[13px] text-slate-700">
            {t("bandeja.claims")} {t("bandeja.selected")}
          </span>
          <button
            type="button"
            onClick={toggleAll}
            className="rounded-md px-2.5 py-1.5 text-[13px] font-medium text-violet-700 transition-colors hover:bg-violet-50"
          >
            {allSelected
              ? t("bandeja.quitarSeleccion")
              : t("bandeja.seleccionarPagina").replace("{n}", String(allIds.length))}
          </button>
          {selectedIds.size > 0 && (
            <button
              type="button"
              onClick={() => onDeleteMany([...selectedIds], clearSelection)}
              className="ml-auto rounded-md border border-red-300 px-3 py-1.5 text-[13px] font-medium text-red-700 transition-colors hover:bg-red-50"
            >
              {t("bandeja.deleteSelected")} ({selectedIds.size})
            </button>
          )}
        </div>
      )}

      {/*
        * Esta caja NO scrollea. Scrollea la que la envuelve en DashboardClient.
        *
        * Tenia `max-h` + `overflow-auto` propios para que el encabezado `sticky`
        * tuviera contra que pegarse. Pero la envoltura de arriba —`min-h-0
        * flex-1 overflow-auto`— ya es un scroller, y el `<main>` del layout
        * otro: TRES contenedores anidados. Con 20 filas no se notaba porque
        * nada llegaba a scrollear; a 100 aparecian dos barras verticales, el
        * encabezado se pegaba dos veces y la rueda movia la caja equivocada.
        * Era «a 100 se rompe».
        *
        * El `sticky` sigue funcionando: se pega contra el scroller mas cercano,
        * que ahora es uno solo.
        */}
      <div role="region" aria-label={t("bandeja.tableLabel")}>
        <table className="w-full table-auto text-left" aria-label={t("bandeja.tableLabel")}>
          <thead className="sticky top-0 z-10 bg-slate-50">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    /*
                     * `rotulo` es la clase de `globals.css` que ya usan los
                     * indicadores y las etiquetas de campo: el encabezado de
                     * columna es exactamente eso, un rotulo, y hasta ahora
                     * repetia las mismas cuatro utilidades a mano con otro
                     * tamano.
                     */
                    /*
                     * `text-slate-500` y no 400: el 400 sobre blanco da
                     * 2.6:1, muy por debajo del 4.5:1 que pide texto. El 500 da
                     * 4.8:1. Es el nombre de la columna, no una decoracion.
                     */
                    className="rotulo sticky top-0 whitespace-nowrap bg-slate-50 px-3 py-2.5 text-slate-500 shadow-[inset_0_-1px_0_0_theme(colors.slate.200)] first:pl-5 last:pr-5"
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
            {table.getRowModel().rows.map((row) => {
              const isSelected = selectedIds.has(row.original.id);
              return (
                <tr
                  key={row.id}
                  onClick={() =>
                    seleccionando
                      ? toggleOne(row.original.id)
                      : router.push(`/casos/${row.original.id}`)
                  }
                  /*
                   * La ultima fila no lleva linea: el borde de la tarjeta ya
                   * cierra la lista, y las dos juntas se ven como un doble filo.
                   */
                  /*
                   * Las filas ya eran navegables con teclado (`tabIndex={0}` y
                   * Enter/Espacio) pero no dibujaban NADA al recibir el foco:
                   * quien no usa mouse recorria 20 filas a ciegas. El anillo va
                   * por dentro (`ring-inset`) porque una fila de tabla recorta
                   * lo que se dibuja afuera.
                   */
                  className={`group cursor-pointer border-b border-slate-100 transition-colors last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500 ${
                    /*
                     * Seleccionar es un ESTADO; borrar es una ACCION. El rojo
                     * es de la accion, y pintaba de alarma diez filas que la
                     * persona solo habia marcado.
                     */
                    isSelected ? "bg-violet-50" : "hover:bg-violet-50"
                  }`}
                  role="row"
                  aria-label={`Siniestro ${formatCaseId(row.original.id)}`}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (seleccionando) toggleOne(row.original.id);
                      else router.push(`/casos/${row.original.id}`);
                    }
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="px-3 py-3 align-middle first:pl-5 last:pr-5"
                      onClick={
                        cell.column.id === "select" || cell.column.id === "row-delete"
                          ? (e) => e.stopPropagation()
                          : undefined
                      }
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Checkbox that supports the indeterminate state via a ref callback. */
