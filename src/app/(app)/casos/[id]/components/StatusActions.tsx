/**
 * StatusActions — botones de acción según el estado del caso.
 *
 * Conviven dos FSM: la del simulador viejo y la del intake por mail/WhatsApp.
 *
 *   listo (legado):            «Cerrar siniestro» + «Escalar» + «Exportar al Core»
 *   esperando (legado):        «Marcar completo» + «Escalar» + «Cerrar»
 *   escalado (legado):         «Resolver escalado → Listo» + «Cerrar»
 *   procesando:                sin botones — spinner
 *   listo_para_core:           «Confirmar y dejar listo» (sin confirmar, con permiso),
 *                              o «Confirmado por …» ya confirmado; «Entregado por fuera» + «Cerrar»
 *   error_core:                «Entregado por fuera» + «Cerrar» + re-analizar
 *   enviado_a_core:            «Pasar a liquidación» + «Cerrar»
 *   en_liquidacion:            «Marcar pagado» + «Marcar rechazado» + «Cerrar»
 *   pagado / rechazado:        banner de sólo lectura
 *   requiere_especialista:     «Revisado: pasar a Listo para Core» + «Cerrar» + «Devolver al agente» (E24)
 *   info_faltante /
 *   confirmacion_pendiente:    reenviar el pedido (P8), «Tomar el control» (D-F2)
 *   cerrado:                   banner de sólo lectura, o «Reabrir y reenviar» (P8)
 *
 * Las salidas a mano (`SALIDAS_A_MANO`) piden `puedeCambiarEstado` y un segundo
 * clic: ninguna se deshace.
 */

"use client";

import { useState } from "react";
import type { CaseStatus } from "@/lib/schemas/cases";
import { useT } from "@/lib/i18n/LocaleContext";
import type { ClaveDelCliente } from "@/lib/i18n";
import { ExportToCorePanel } from "./ExportToCorePanel";
import type { EstadoDeAcciones } from "@/server/cases/acciones";

interface StatusActionsProps {
  caseId: string;
  status: CaseStatus;
  caseNumber: string;
  onClose: () => void;
  onEscalate: () => void;
  onTransition: (toStatus: CaseStatus) => void;
  onReAnalyze: () => void;
  reAnalyzing: boolean;
  onError: (msg: string) => void;
  /** Whether any dialog is currently open (prevent double-clicks) */
  dialogOpen: boolean;
  acciones: EstadoDeAcciones;
  puedeCambiarEstado: boolean;
  onConfirmarListo: () => void;
  onRevisadoListo: () => void;
  /** P8. Sin esto no se muestra nada de reenviar ni reabrir. */
  onReenviar?: (reabrir: boolean) => void;
  reenviando?: boolean;
  /** D-F2. Sin esto el botón de «Tomar el control» no se muestra. */
  puedeTomarElControl?: boolean;
  onTomarElControl?: () => void;
  /** E24. Sin esto el botón de «Devolver al agente» no se muestra. */
  puedeDevolverAlAgente?: boolean;
  onDevolverAlAgente?: () => void;
}

function ReAnalyzeButton({
  onReAnalyze,
  reAnalyzing,
  t,
}: {
  onReAnalyze: () => void;
  reAnalyzing: boolean;
  t: (key: ClaveDelCliente) => string;
}) {
  return (
    <button
      type="button"
      onClick={onReAnalyze}
      disabled={reAnalyzing}
      data-testid="action-re-analizar"
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      title={t("case.detail.reAnalyze")}
    >
      {reAnalyzing ? (
        <svg
          className="w-3.5 h-3.5 animate-spin"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="w-3.5 h-3.5"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z"
            clipRule="evenodd"
          />
        </svg>
      )}
      {t("case.detail.reAnalyze")}
    </button>
  );
}

const CLASE_SECUNDARIO =
  "rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";
const CLASE_SALIDA =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

function BannerCerrado({ etiqueta }: { etiqueta: string }) {
  return (
    <div
      className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-600"
      role="status"
      aria-label={etiqueta}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="w-4 h-4 text-slate-400"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z"
          clipRule="evenodd"
        />
      </svg>
      {etiqueta}
    </div>
  );
}

type Salida = readonly [hacia: CaseStatus, etiqueta: ClaveDelCliente, testId: string];

/**
 * Las salidas a mano de un estado: el primer clic pregunta, el segundo manda
 * el PATCH. Una sola armada a la vez y con su rótulo a la vista: pagado y
 * rechazado van lado a lado y ninguna se deshace.
 */
function SalidasAMano({
  salidas,
  onTransition,
  dialogOpen,
  t,
}: {
  salidas: readonly Salida[];
  onTransition: (toStatus: CaseStatus) => void;
  dialogOpen: boolean;
  t: (key: ClaveDelCliente) => string;
}) {
  const [armada, setArmada] = useState<CaseStatus | null>(null);

  return (
    <>
      {salidas.map(([hacia, etiqueta, testId]) =>
        armada !== hacia ? (
          <button
            key={hacia}
            type="button"
            onClick={() => setArmada(hacia)}
            disabled={dialogOpen}
            data-testid={testId}
            className={CLASE_SALIDA}
          >
            {t(etiqueta)}
          </button>
        ) : (
          <span
            key={hacia}
            role="group"
            aria-label={t(etiqueta)}
            className="inline-flex flex-wrap items-center gap-2"
          >
            <span className="text-sm font-medium text-slate-800">{t(etiqueta)}</span>
            <span className="text-sm text-slate-600">{t("case.detail.salidaConfirmar")}</span>
            <button
              type="button"
              onClick={() => {
                setArmada(null);
                onTransition(hacia);
              }}
              disabled={dialogOpen}
              data-testid={`${testId}-confirmar`}
              className={CLASE_SALIDA}
            >
              {t("case.detail.salidaSi")}
            </button>
            <button type="button" onClick={() => setArmada(null)} className={CLASE_SECUNDARIO}>
              {t("case.detail.salidaNo")}
            </button>
          </span>
        )
      )}
    </>
  );
}

export function StatusActions({
  caseId,
  status,
  onClose,
  onEscalate,
  onTransition,
  onReAnalyze,
  reAnalyzing,
  onError,
  dialogOpen,
  acciones,
  puedeCambiarEstado,
  onConfirmarListo,
  onRevisadoListo,
  onReenviar,
  reenviando,
  puedeTomarElControl,
  onTomarElControl,
  puedeDevolverAlAgente,
  onDevolverAlAgente,
}: StatusActionsProps) {
  const t = useT();
  // ── cerrado — read-only banner, o «Reabrir y reenviar» (P8) ────────────────
  if (status === "cerrado") {
    const banner = <BannerCerrado etiqueta={t("case.detail.closedBanner")} />;

    if (!(acciones.reabrible && puedeCambiarEstado && onReenviar)) {
      return banner;
    }

    return (
      <div className="flex flex-wrap items-center gap-2">
        {banner}
        <button
          type="button"
          onClick={() => onReenviar(true)}
          disabled={!acciones.puedeReenviar || reenviando}
          data-testid="action-reabrir-reenviar"
          aria-describedby={acciones.motivoSinReenvio ? "motivo-reenvio" : undefined}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t("reenvio.reabrir")}
        </button>
        {acciones.motivoSinReenvio && (
          <p id="motivo-reenvio" className="text-xs text-slate-500">
            {t(`reenvio.motivo.${acciones.motivoSinReenvio}`)}
          </p>
        )}
      </div>
    );
  }

  // ── pagado / rechazado — la liquidación terminó; sólo lectura ─────────────
  if (status === "pagado" || status === "rechazado") {
    return (
      <BannerCerrado
        etiqueta={t(status === "pagado" ? "case.detail.pagadoBanner" : "case.detail.rechazadoBanner")}
      />
    );
  }

  const botonCerrar = (
    <button
      type="button"
      onClick={onClose}
      disabled={dialogOpen}
      data-testid="action-cerrar"
      className={CLASE_SECUNDARIO}
    >
      {t("case.detail.close")}
    </button>
  );

  // La key con el estado: si el caso cambia, una confirmación armada no pasa a
  // la salida que quedó en el mismo lugar.
  const salidas = (...lista: Salida[]) => (
    <SalidasAMano key={status} salidas={lista} onTransition={onTransition} dialogOpen={dialogOpen} t={t} />
  );

  // ── en_liquidacion — pagado / rechazado / cerrar ──────────────────────────
  // Sin re-analizar: no tiene arista en el grafo y la ruta contesta 409.
  if (status === "en_liquidacion") {
    if (!puedeCambiarEstado) return null;
    return (
      <div className="flex flex-wrap items-center gap-2">
        {salidas(
          ["pagado", "case.detail.marcarPagado", "action-pagado"],
          ["rechazado", "case.detail.marcarRechazado", "action-rechazado"]
        )}
        {botonCerrar}
      </div>
    );
  }

  // ── enviado_a_core — liquidación + cerrar ─────────────────────────────────
  // Sin re-analizar: la ruta no desengancha un caso ya enviado.
  if (status === "enviado_a_core") {
    if (!puedeCambiarEstado) return null;
    return (
      <div className="flex flex-wrap items-center gap-2">
        {salidas(["en_liquidacion", "case.detail.pasarALiquidacion", "action-liquidacion"])}
        {botonCerrar}
      </div>
    );
  }

  // ── error_core — entregado por fuera + cerrar + re-analizar ───────────────
  if (status === "error_core") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {puedeCambiarEstado && (
          <>
            {salidas(["en_liquidacion", "case.detail.entregadoPorFuera", "action-liquidacion"])}
            {botonCerrar}
          </>
        )}
        <ReAnalyzeButton onReAnalyze={onReAnalyze} reAnalyzing={reAnalyzing} t={t} />
      </div>
    );
  }

  // ── procesando — spinner + re-analyze ─────────────────────────────────────
  if (status === "procesando") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700"
          role="status"
          aria-label={t("case.detail.processing")}
          aria-live="polite"
        >
          <svg
            className="w-4 h-4 animate-spin text-blue-400"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          {t("case.detail.processing")}
        </div>
        <ReAnalyzeButton onReAnalyze={onReAnalyze} reAnalyzing={reAnalyzing} t={t} />
      </div>
    );
  }

  // ── listo — cerrar + escalar + exportar + re-analizar ─────────────────────
  if (status === "listo") {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={dialogOpen}
            data-testid="action-cerrar"
            className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t("case.detail.close")}
          </button>
          <button
            type="button"
            onClick={onEscalate}
            disabled={dialogOpen}
            data-testid="action-escalar"
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t("case.detail.escalate")}
          </button>
          <ReAnalyzeButton onReAnalyze={onReAnalyze} reAnalyzing={reAnalyzing} t={t} />
        </div>
        <ExportToCorePanel caseId={caseId} onError={onError} />
      </div>
    );
  }

  // ── esperando — marcar completo + escalar + cerrar + re-analizar ───────────
  if (status === "esperando") {
    return (
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onTransition("listo")}
          disabled={dialogOpen}
          data-testid="action-marcar-completo"
          className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t("case.detail.markComplete")}
        </button>
        <button
          type="button"
          onClick={onEscalate}
          disabled={dialogOpen}
          data-testid="action-escalar"
          className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t("case.detail.escalate")}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={dialogOpen}
          data-testid="action-cerrar"
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t("case.detail.close")}
        </button>
        <ReAnalyzeButton onReAnalyze={onReAnalyze} reAnalyzing={reAnalyzing} t={t} />
      </div>
    );
  }

  // ── info_faltante / confirmacion_pendiente — reenviar pedido (P8) ──────────
  if (status === "info_faltante" || status === "confirmacion_pendiente") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {onReenviar && (
          <>
            <button
              type="button"
              onClick={() => onReenviar(false)}
              disabled={!acciones.puedeReenviar || reenviando}
              data-testid="action-reenviar-pedido"
              aria-describedby={acciones.motivoSinReenvio ? "motivo-reenvio" : undefined}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {t("reenvio.boton")}
            </button>
            {acciones.motivoSinReenvio && (
              <p id="motivo-reenvio" className="text-xs text-slate-500">
                {t(`reenvio.motivo.${acciones.motivoSinReenvio}`)}
              </p>
            )}
          </>
        )}
        {puedeTomarElControl && onTomarElControl && (
          <button
            type="button"
            onClick={onTomarElControl}
            disabled={dialogOpen}
            data-testid="action-tomar-el-control"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t("case.detail.tomarElControl")}
          </button>
        )}
        <ReAnalyzeButton onReAnalyze={onReAnalyze} reAnalyzing={reAnalyzing} t={t} />
      </div>
    );
  }

  // ── escalado — resolver + cerrar + re-analizar ─────────────────────────────
  if (status === "escalado") {
    return (
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onTransition("listo")}
          disabled={dialogOpen}
          data-testid="action-resolver-escalado"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t("case.detail.resolveEscalated")}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={dialogOpen}
          data-testid="action-cerrar"
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t("case.detail.close")}
        </button>
        <ReAnalyzeButton onReAnalyze={onReAnalyze} reAnalyzing={reAnalyzing} t={t} />
      </div>
    );
  }

  // ── listo_para_core — confirmar + entregado por fuera + cerrar + re-analizar ─
  // Sin conector de Core el caso no sale solo: lo saca una persona.
  if (status === "listo_para_core") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {puedeCambiarEstado &&
          (!acciones.confirmado ? (
            <button
              type="button"
              onClick={onConfirmarListo}
              disabled={dialogOpen}
              data-testid="action-confirmar-listo"
              className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {t("case.detail.confirmarListo")}
            </button>
          ) : (
            <span
              role="status"
              data-testid="listo-confirmado"
              className="text-sm text-slate-600"
            >
              {acciones.confirmadoPor
                ? t("case.detail.confirmadoPor").replace("{quien}", acciones.confirmadoPor)
                : t("case.detail.confirmadoAnonimo")}
            </span>
          ))}
        {puedeCambiarEstado && (
          <>
            {salidas(["en_liquidacion", "case.detail.entregadoPorFuera", "action-liquidacion"])}
            {botonCerrar}
          </>
        )}
        <ReAnalyzeButton onReAnalyze={onReAnalyze} reAnalyzing={reAnalyzing} t={t} />
      </div>
    );
  }

  // ── requiere_especialista — revisado + cerrar + re-analizar ─────────────────
  if (status === "requiere_especialista") {
    return (
      <div className="flex flex-wrap gap-2">
        {puedeCambiarEstado && (
          <>
            <button
              type="button"
              onClick={onRevisadoListo}
              disabled={dialogOpen}
              data-testid="action-revisado-listo"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {t("case.detail.revisadoListo")}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={dialogOpen}
              data-testid="action-cerrar"
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {t("case.detail.close")}
            </button>
          </>
        )}
        {puedeDevolverAlAgente && onDevolverAlAgente && (
          <button
            type="button"
            onClick={onDevolverAlAgente}
            disabled={dialogOpen}
            data-testid="action-devolver-al-agente"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t("case.detail.devolverAlAgente")}
          </button>
        )}
        <ReAnalyzeButton onReAnalyze={onReAnalyze} reAnalyzing={reAnalyzing} t={t} />
      </div>
    );
  }

  // ── fallback (recibido, etc.) — re-analizar only ────────────────────────────
  return (
    <ReAnalyzeButton onReAnalyze={onReAnalyze} reAnalyzing={reAnalyzing} t={t} />
  );
}
