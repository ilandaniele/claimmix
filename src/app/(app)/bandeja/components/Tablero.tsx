"use client";

import Link from "next/link";
import { agruparEnColumnas } from "@/core/case/tablero";
import { CLAVES_DE_ESTADO, type ClaveDeEstado } from "@/core/case/filtro-de-estado";
import { formatCaseNumber } from "@/core/case/numero";
import { AseguradoYPoliza } from "./AseguradoYPoliza";
import { nombreDelTipo, type TipoPropio } from "./grupos-de-filtro";
import { SeverityBadge } from "./SeverityBadge";
import type { CaseRow } from "@/server/cases/list";
import type { ClaveDelCliente } from "@/lib/i18n";
import { useLocale } from "@/lib/i18n/LocaleContext";
import { formatAge, formatDate } from "@/lib/utils";

/**
 * El rótulo de cada columna: las mismas seis claves y los mismos textos que
 * ya usa el chip de estado del panel de filtros (`grupos-de-filtro.ts`). No
 * hace falta una traducción nueva por columna.
 */
const ETIQUETA_DE_COLUMNA: Record<ClaveDeEstado, ClaveDelCliente> = {
  procesando: "tabs.procesando",
  esperando: "tabs.esperando",
  confirmacion_pendiente: "status.confirmacion_pendiente",
  escalado: "tabs.escalado",
  listo: "tabs.listo",
  cerrado: "tabs.cerrado",
};

interface TableroProps {
  /** Las más nuevas de cada columna, tal como las trae `listarTablero`. */
  casos: readonly CaseRow[];
  /** El total real de cada opción (la "M" de "N de M"). */
  totales: Record<ClaveDeEstado, number>;
  /** Para escribir el tipo de las tarjetas igual que la lista. */
  tiposPropios: readonly TipoPropio[];
  /** Los parámetros de la URL que se está mirando: «Ver todos» los conserva. */
  paramsActuales: string;
}

/**
 * El tablero de la bandeja: las mismas seis columnas del filtro de estado,
 * de sólo lectura.
 *
 * Sin arrastrar y sin botones de estado: es un mapa de dónde está el
 * trabajo, no un lugar para moverlo. Cambiar el estado de un caso se sigue
 * haciendo desde su detalle.
 *
 * Una columna sin casos se angosta a una tira con su rótulo de costado: ocupa
 * lo justo para que se vea que está, y el lugar que libera es de las que tienen
 * trabajo.
 */
export function Tablero({ casos, totales, tiposPropios, paramsActuales }: TableroProps) {
  const { t, locale } = useLocale();
  const { columnas } = agruparEnColumnas(casos);

  // «Ver todos» sigue con los filtros puestos y sólo cambia el estado; el tablero y la página no viajan.
  const hrefDeLaColumna = (clave: ClaveDeEstado) => {
    const params = new URLSearchParams(paramsActuales);
    params.delete("status");
    params.delete("vista");
    params.delete("page");
    params.set("status", clave);
    return `/bandeja?${params.toString()}`;
  };

  return (
    <div className="scroll-fino flex h-full gap-3 overflow-x-auto px-5 pb-5">
      {CLAVES_DE_ESTADO.map((clave) => {
        const casosDeLaColumna = columnas[clave];

        if (casosDeLaColumna.length === 0) {
          return (
            <div
              key={clave}
              role="group"
              title={t("tablero.vacio")}
              aria-label={t("tablero.vacio")}
              className="flex w-10 flex-none flex-col items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 py-3"
            >
              <span className="cifra text-[12px] text-slate-500">{totales[clave]}</span>
              <h3 className="rotulo text-slate-600 [writing-mode:vertical-rl]">
                {t(ETIQUETA_DE_COLUMNA[clave])}
              </h3>
            </div>
          );
        }

        return (
          <div
            key={clave}
            className="flex min-h-0 w-[16.5rem] flex-none flex-col rounded-xl border border-slate-200 bg-slate-50"
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
              <h3 className="rotulo text-slate-600">{t(ETIQUETA_DE_COLUMNA[clave])}</h3>
              <span className="cifra text-[12px] text-slate-500">
                {casosDeLaColumna.length} {t("pagination.of")} {totales[clave]}
              </span>
            </div>

            <div className="scroll-fino min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
              {casosDeLaColumna.map((caso) => {
                const tipo = nombreDelTipo(caso.claim_type, t, tiposPropios);
                return (
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
                    <div className="mt-1">
                      <AseguradoYPoliza nombre={caso.policyholder_name} poliza={caso.policy_number} />
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-2 text-[12px] text-slate-500">
                      {tipo && <span>{tipo}</span>}
                      <span title={formatDate(caso.created_at, locale)}>
                        {formatAge(caso.created_at, t)}
                      </span>
                      <span>
                        {caso.assigned_name ??
                          (caso.assigned_to ? t("case.detail.assigned") : t("case.detail.unassigned"))}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>

            <Link
              href={hrefDeLaColumna(clave)}
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
