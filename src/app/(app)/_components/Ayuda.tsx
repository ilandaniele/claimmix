"use client";

import { useState } from "react";
import { CircleHelp } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import type { TranslationKey } from "@/lib/i18n";
import { useDialogoModal } from "./dialogo-modal";

// Mismas claves que `ComoUsar` en la demo pública: un solo texto para las dos.
const PASOS: ReadonlyArray<{ titulo: TranslationKey; texto: TranslationKey }> = [
  { titulo: "ayuda.paso1.titulo", texto: "ayuda.paso1.texto" },
  { titulo: "ayuda.paso2.titulo", texto: "ayuda.paso2.texto" },
  { titulo: "ayuda.paso3.titulo", texto: "ayuda.paso3.texto" },
  { titulo: "ayuda.paso4.titulo", texto: "ayuda.paso4.texto" },
  { titulo: "ayuda.paso5.titulo", texto: "ayuda.paso5.texto" },
];

function AyudaDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const panelRef = useDialogoModal<HTMLDivElement>(onClose);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ayuda-titulo"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl"
      >
        <h2 id="ayuda-titulo" className="text-lg font-semibold text-slate-900 mb-4">
          {t("ayuda.titulo")}
        </h2>
        <div className="space-y-4">
          {PASOS.map((paso) => (
            <div key={paso.titulo}>
              <div className="text-sm font-semibold text-slate-800">{t(paso.titulo)}</div>
              <p className="mt-1 text-sm text-slate-600">{t(paso.texto)}</p>
            </div>
          ))}
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 transition-colors"
          >
            {t("ayuda.cerrar")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Ayuda() {
  const t = useT();
  const [abierto, setAbierto] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setAbierto(true)}
        aria-label={t("ayuda.abrir")}
        title={t("ayuda.abrir")}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
      >
        <CircleHelp size={15} />
      </button>
      {abierto && <AyudaDialog onClose={() => setAbierto(false)} />}
    </>
  );
}
