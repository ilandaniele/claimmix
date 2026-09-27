"use client";

import Link from "next/link";
import { agruparEnColumnas } from "@/core/case/tablero";
import { CLAVES_DE_ESTADO, type ClaveDeEstado } from "@/core/case/filtro-de-estado";
import { formatCaseNumber } from "@/core/case/numero";
import { SeverityBadge } from "./SeverityBadge";
import { Vacio } from "./Vacio";
import type { CaseRow } from "@/server/cases/list";
import type { TranslationKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * El rótulo de cada columna: las mismas seis claves y los mismos textos que
 * ya usa el chip de estado del panel de filtros (`grupos-de-filtro.ts`). No
 * hace falta una traducción nueva por columna.
 */
const ETIQUETA_DE_COLUMNA: Record<ClaveDeEstado, TranslationKey> = {
  procesando: "tabs.procesando",
  esperando: "tabs.esperando",
  confirmacion_pendiente: "status.confirmacion_pendiente",
  escalado: "tabs.escalado",
  listo: "tabs.listo",
  cerrado: "tabs.cerrado",
};

interface TableroProps {
  /** Lo que ya está cargado en esta página. No pide nada nuevo a la base. */
  casos: readonly CaseRow[];
  /** El total real de cada opción (la "M" de "N de M"), de `contarPorOpcion`. */
  totales: Record<ClaveDeEstado, number>;
}

/**
 * El tablero de la bandeja: las mismas seis columnas del filtro de estado,
 * de sólo lectura.
 *
 * Sin arrastrar y sin botones de estado: es un mapa de dónde está el
 * trabajo, no un lugar para moverlo. Cambiar el estado de un caso se sigue
 * haciendo desde su detalle.
 */
export function Tablero({ casos, totales }: TableroProps) {
  const t = useT();
  const { columnas } = agruparEnColumnas(casos);

  return (
    <div className="scroll-fino grid h-full auto-cols-[16.5rem] grid-flow-col gap-3 overflow-x-auto px-5 pb-5">
      {CLAVES_DE_ESTADO.map((clave) => {
        const casosDeLaColumna = columnas[clave];
        return (
          <div
            key={clave}
            className="flex min-h-0 flex-col rounded-xl border border-slate-200 bg-slate-50"
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
              <h3 className="rotulo text-slate-600">{t(ETIQUETA_DE_COLUMNA[clave])}</h3>
              <span className="cifra text-[12px] text-slate-500">
                {casosDeLaColumna.length} {t("pagination.of")} {totales[clave]}
              </span>
            </div>

            <div className="scroll-fino min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
              {casosDeLaColumna.length === 0 ? (
                <p className="px-2 py-4 text-center text-[12.5px] text-slate-400">
                  {t("tablero.vacio")}
                </p>
              ) : (
                casosDeLaColumna.map((caso) => (
                  <Link
                    key={caso.id}
                    href={`/casos/${caso.id}`}
                    prefetch={false}
                    className="block rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm transition-colors hover:border-violet-300"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[12.5px] font-medium text-violet-700">
                        {formatCaseNumber(caso.id)}
                      </span>
                      {caso.severity && <SeverityBadge severity={caso.severity} />}
                    </div>
                    <p className="mt-1 truncate text-[13px] font-medium text-slate-900">
                      {caso.policyholder_name ?? <Vacio />}
                    </p>
                  </Link>
                ))
              )}
            </div>

            <Link
              href={`/bandeja?status=${clave}`}
              prefetch={false}
              className="border-t border-slate-200 px-3 py-2 text-center text-[12.5px] font-medium text-violet-700 hover:underline"
            >
              {t("tablero.verTodos")}
            </Link>
          </div>
        );
      })}
    </div>
  );
}
