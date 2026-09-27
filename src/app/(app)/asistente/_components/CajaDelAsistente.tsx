"use client";

/**
 * CajaDelAsistente — pregunta y respuesta, con las últimas 5 en pantalla.
 *
 * La respuesta se muestra como texto plano (`white-space: pre-wrap`), nunca
 * como HTML ni markdown: es texto de un modelo, y el riesgo de inyección no
 * termina en el servidor. Los enlaces a casos salen únicamente de `casos[]`,
 * nunca del texto libre de la respuesta.
 *
 * El historial es sólo de este componente: nunca viaja al servidor y se pierde
 * al recargar la página.
 *
 * Vive en `/asistente` (page.tsx, sin `textareaRef`) y adentro del panel
 * flotante (`AsistenteFlotante.tsx`, que pasa su propio ref y enfoca el
 * textarea en cada apertura).
 */

import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useT } from "@/lib/i18n/LocaleContext";
import { formatCaseNumber } from "@/core/case/numero";
import { formatDate } from "@/lib/utils";
import { StatusBadge } from "@/app/(app)/bandeja/components/StatusBadge";
import type { CaseStatus } from "@/lib/schemas/cases";

interface CasoEncontrado {
  id: string;
  etiqueta: string;
  numero: string;
  creado: string;
  estado: CaseStatus;
}

interface RespuestaDelAsistente {
  texto: string;
  herramienta: "contar_casos" | "buscar_caso" | "ninguna";
  casos: CasoEncontrado[];
}

interface Intercambio {
  pregunta: string;
  respuesta: RespuestaDelAsistente;
}

/** Las últimas 5, ni una más: es un historial de sesión, no un registro. */
const TOPE_HISTORIAL = 5;

const ESTILO_CHIP =
  "rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 " +
  "transition-colors hover:bg-slate-50 motion-reduce:transition-none " +
  "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700";

interface CajaDelAsistenteProps {
  /** Del panel flotante, que enfoca el textarea al abrir. Sin él, la caja usa uno propio. */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

export function CajaDelAsistente({ textareaRef: textareaRefExterno }: CajaDelAsistenteProps = {}) {
  const t = useT();
  const { locale } = useLocale();
  const pathname = usePathname();
  const [pregunta, setPregunta] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [historial, setHistorial] = useState<Intercambio[]>([]);
  const [error, setError] = useState<string | null>(null);
  const finRef = useRef<HTMLDivElement>(null);
  const textareaPropio = useRef<HTMLTextAreaElement>(null);
  const textareaRef = textareaRefExterno ?? textareaPropio;

  // "Resumí este caso": sólo dentro de /casos/<id>. El número sale del propio
  // id de la ruta — `formatCaseNumber` es puro, no hace falta pedirlo de nuevo.
  const casoActual = useMemo(() => {
    const m = /^\/casos\/([0-9a-fA-F-]+)$/.exec(pathname ?? "");
    return m ? { numero: formatCaseNumber(m[1]!) } : null;
  }, [pathname]);

  const enviar = useCallback(
    async (texto: string) => {
      const limpia = texto.trim();
      if (limpia.length < 3 || enviando) return;

      setEnviando(true);
      setError(null);

      try {
        const res = await fetch("/api/asistente", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pregunta: limpia }),
        });

        if (res.status === 429) {
          setError(t("asistente.demasiadas"));
          return;
        }

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          const msg =
            (data as { error?: { message?: string } })?.error?.message ?? t("asistente.error");
          setError(msg);
          return;
        }

        const data = (await res.json()) as RespuestaDelAsistente;
        setHistorial((prev) => [...prev, { pregunta: limpia, respuesta: data }].slice(-TOPE_HISTORIAL));
        setPregunta("");
        // Opcional: jsdom (tests) no implementa scrollIntoView.
        requestAnimationFrame(() => finRef.current?.scrollIntoView?.({ block: "end" }));
      } catch {
        setError(t("asistente.error"));
      } finally {
        setEnviando(false);
      }
    },
    [enviando, t]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void enviar(pregunta);
    },
    [pregunta, enviar]
  );

  // El chip de "buscá el caso de…" llena y enfoca, nunca envía solo.
  // Sin useCallback: sólo la usa un onClick, no hace falta memoizarla, y el
  // compilador de React no puede seguir un `.current` leído adentro.
  function llenarYEnfocar(texto: string) {
    setPregunta(texto);
    textareaRef.current?.focus();
  }

  return (
    <div className="space-y-4">
      {historial.length === 0 && (
        <div className="flex flex-wrap gap-2" data-testid="asistente-chips">
          <button type="button" className={ESTILO_CHIP} onClick={() => void enviar(t("asistente.chip.conteoMes"))}>
            {t("asistente.chip.conteoMes")}
          </button>
          <button
            type="button"
            className={ESTILO_CHIP}
            onClick={() => void enviar(t("asistente.chip.whatsappsHoy"))}
          >
            {t("asistente.chip.whatsappsHoy")}
          </button>
          <button
            type="button"
            className={ESTILO_CHIP}
            onClick={() => void enviar(t("asistente.chip.reclamos30dias"))}
          >
            {t("asistente.chip.reclamos30dias")}
          </button>
          <button
            type="button"
            className={ESTILO_CHIP}
            onClick={() => llenarYEnfocar(t("asistente.chip.buscarCasoPrefill"))}
          >
            {t("asistente.chip.buscarCasoLabel")}
          </button>
          {casoActual && (
            <button
              type="button"
              className={ESTILO_CHIP}
              onClick={() =>
                void enviar(t("asistente.chip.resumirCasoPregunta").replace("{numero}", casoActual.numero))
              }
            >
              {t("asistente.chip.resumirCaso")}
            </button>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <label htmlFor="pregunta-asistente" className="block text-sm font-medium text-slate-700 dark:text-slate-300">
          {t("asistente.preguntaLabel")}
        </label>
        <textarea
          id="pregunta-asistente"
          ref={textareaRef}
          rows={3}
          value={pregunta}
          onChange={(e) => setPregunta(e.target.value)}
          placeholder={t("asistente.placeholder")}
          maxLength={500}
          className="w-full resize-none rounded-md border border-control px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400 dark:bg-slate-900 dark:text-slate-100"
        />
        <button
          type="submit"
          disabled={enviando || pregunta.trim().length < 3}
          data-testid="asistente-submit"
          className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {enviando ? t("asistente.enviando") : t("asistente.enviar")}
        </button>
      </form>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {historial.length > 0 && (
        <ul className="space-y-3">
          {historial.map((intercambio, i) => (
            <li
              key={i}
              className="rounded-md border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-800"
            >
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{intercambio.pregunta}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100">
                {intercambio.respuesta.texto}
              </p>
              {intercambio.respuesta.herramienta === "buscar_caso" && intercambio.respuesta.casos.length === 1 && (
                <p className="mt-2 text-xs italic text-slate-500 dark:text-slate-400">
                  {t("asistente.avisoResumenIA")}
                </p>
              )}
              {intercambio.respuesta.casos.length > 0 && (
                <ul className="mt-3 space-y-1.5 border-t border-slate-100 pt-3 dark:border-slate-700">
                  {intercambio.respuesta.casos.map((caso) => (
                    <li key={caso.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <Link href={`/casos/${caso.id}`} className="text-sm font-medium text-blue-600 hover:underline">
                        {caso.etiqueta}
                      </Link>
                      <span className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                        <span>{caso.numero}</span>
                        <span>{formatDate(caso.creado, locale, { hour: undefined, minute: undefined })}</span>
                        <StatusBadge status={caso.estado} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {/* Ancla de scroll: `<div>` no es hijo válido de `<ul>` (sólo `<li>`), así que va en el último `<li>`. */}
              {i === historial.length - 1 && <div ref={finRef} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
