"use client";

/**
 * CajaDelAsistente — pregunta y respuesta, una por vez.
 *
 * La respuesta se muestra como texto plano (`white-space: pre-wrap`), nunca
 * como HTML ni markdown: es texto de un modelo, y el riesgo de inyección no
 * termina en el servidor. Los enlaces a casos salen únicamente de `casos[]`,
 * nunca del texto libre de la respuesta.
 */

import { useCallback, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/LocaleContext";

interface CasoEncontrado {
  id: string;
  etiqueta: string;
}

interface RespuestaDelAsistente {
  texto: string;
  herramienta: "contar_casos" | "buscar_caso" | "ninguna";
  casos: CasoEncontrado[];
}

export function CajaDelAsistente() {
  const t = useT();
  const [pregunta, setPregunta] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [respuesta, setRespuesta] = useState<RespuestaDelAsistente | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (pregunta.trim().length < 3 || enviando) return;

      setEnviando(true);
      setError(null);
      setRespuesta(null);

      try {
        const res = await fetch("/api/asistente", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pregunta: pregunta.trim() }),
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
        setRespuesta(data);
      } catch {
        setError(t("asistente.error"));
      } finally {
        setEnviando(false);
      }
    },
    [pregunta, enviando, t]
  );

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="space-y-3">
        <label htmlFor="pregunta-asistente" className="block text-sm font-medium text-slate-700">
          {t("asistente.preguntaLabel")}
        </label>
        <textarea
          id="pregunta-asistente"
          rows={3}
          value={pregunta}
          onChange={(e) => setPregunta(e.target.value)}
          placeholder={t("asistente.placeholder")}
          maxLength={500}
          className="w-full rounded-md border border-control px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none"
        />
        <button
          type="submit"
          disabled={enviando || pregunta.trim().length < 3}
          data-testid="asistente-submit"
          className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {enviando ? t("asistente.enviando") : t("asistente.enviar")}
        </button>
      </form>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {respuesta && (
        <div className="rounded-md border border-slate-200 bg-white px-4 py-3">
          <p className="whitespace-pre-wrap text-sm text-slate-800">{respuesta.texto}</p>
          {respuesta.casos.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3">
              {respuesta.casos.map((caso) => (
                <li key={caso.id}>
                  <Link href={`/casos/${caso.id}`} className="text-sm font-medium text-blue-600 hover:underline">
                    {caso.etiqueta}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
