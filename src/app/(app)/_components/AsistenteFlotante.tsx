"use client";

/**
 * AsistenteFlotante — el mismo asistente de `/asistente`, en una caja sobre
 * cualquier pantalla (Plan Pro). Botón flotante + panel; `CajaDelAsistente` se
 * carga recién al primer click (`next/dynamic`, `ssr: false`) para no sumarle
 * peso al bundle de páginas que nunca lo abren (ver `.size-limit.cjs`).
 *
 * El panel es un panel flotante SIN telón: la pantalla de atrás sigue viva y
 * usable, así que no es un diálogo modal — `aria-modal` y la trampa de Tab de
 * `useDialogoModal` (pensada para los diálogos CON telón, como `EscalateDialog`)
 * no le corresponden acá. El contrato es más chico: Escape cierra, el foco
 * inicial va al textarea y al cerrar vuelve al botón que lo abrió — unas
 * pocas líneas locales, en vez de sumarle a `useDialogoModal` un modo "sin
 * trampa" que los otros cuatro diálogos no necesitan.
 *
 * Una vez abierto, el panel queda montado para siempre (oculto con `hidden` +
 * `inert` al cerrar, en vez de desmontarse) para que `CajaDelAsistente` no
 * pierda su historial de sesión entre cierres. La importación dinámica sigue
 * pasando una única vez, en la primera apertura.
 */

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { Sparkles, X } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { cn } from "@/lib/utils";

const CajaDelAsistente = dynamic(
  () => import("../asistente/_components/CajaDelAsistente").then((m) => m.CajaDelAsistente),
  { ssr: false }
);

function PanelDelAsistente({
  abierto,
  onClose,
  textareaRef,
}: {
  abierto: boolean;
  onClose: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const t = useT();

  // Foco inicial al textarea, en CADA apertura (el panel queda montado entre
  // aperturas, esto no es sólo un efecto de montaje). Diferido un frame: en la
  // primera apertura `CajaDelAsistente` puede llegar recién por `next/dynamic`
  // y sin el diferimiento este `focus()` se adelantaría al efecto de montaje
  // propio de la caja; en aperturas siguientes ya está montada y el frame de
  // más no se nota.
  useEffect(() => {
    if (!abierto) return;
    const id = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [abierto, textareaRef]);

  // Sin trampa de Tab: sólo Escape, y sólo mientras está abierto.
  useEffect(() => {
    if (!abierto) return;
    function alApretar(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", alApretar);
    return () => document.removeEventListener("keydown", alApretar);
  }, [abierto, onClose]);

  return (
    <div
      id="asistente-flotante-panel"
      role="dialog"
      aria-labelledby="asistente-flotante-titulo"
      hidden={!abierto}
      inert={!abierto}
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 max-h-[70vh] flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-800 sm:inset-x-auto sm:bottom-24 sm:right-6 sm:w-[400px] sm:rounded-2xl",
        // `.flex` sólo con el panel abierto: mezclado con el atributo `hidden`
        // (misma especificidad que `[hidden]`), una utilidad de display podría
        // ganarle a `display: none` en la cascada.
        abierto ? "flex" : "hidden"
      )}
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <h2 id="asistente-flotante-titulo" className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t("asistente.titulo")}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("asistente.flotante.cerrar")}
          title={t("asistente.flotante.cerrar")}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 motion-reduce:transition-none dark:text-slate-400 dark:hover:bg-slate-700"
        >
          <X size={15} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <CajaDelAsistente textareaRef={textareaRef} />
      </div>
    </div>
  );
}

export function AsistenteFlotante() {
  const t = useT();
  const pathname = usePathname();
  const [montada, setMontada] = useState(false);
  const [abierto, setAbierto] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const botonRef = useRef<HTMLButtonElement>(null);

  function cerrar() {
    setAbierto(false);
    botonRef.current?.focus();
  }

  function alternar() {
    if (abierto) {
      cerrar();
      return;
    }
    setMontada(true);
    setAbierto(true);
  }

  // Ya está la caja entera en pantalla: la flotante estorbaría, no ayuda.
  if (pathname === "/asistente") return null;

  return (
    <>
      <button
        ref={botonRef}
        type="button"
        onClick={alternar}
        aria-label={t("asistente.flotante.abrir")}
        title={t("asistente.flotante.abrir")}
        aria-expanded={abierto}
        aria-controls="asistente-flotante-panel"
        className="fixed bottom-6 right-6 z-40 inline-flex h-12 items-center gap-2 rounded-full bg-violet-600 px-4 text-white shadow-lg transition-colors hover:bg-violet-700 motion-reduce:transition-none"
      >
        <Sparkles size={18} />
        <span className="hidden md:inline text-sm font-medium">{t("asistente.flotante.abrir")}</span>
      </button>
      {montada && <PanelDelAsistente abierto={abierto} onClose={cerrar} textareaRef={textareaRef} />}
    </>
  );
}
