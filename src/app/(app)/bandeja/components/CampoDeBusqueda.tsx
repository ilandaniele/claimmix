"use client";

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { useNavegacion } from "./navegacion-pendiente";
import { useFilterParam } from "./useFilterParam";

const DEMORA_MS = 300;

/**
 * La caja de búsqueda de la bandeja: nombre, póliza o número de caso.
 *
 * El valor se escribe local y recién a los 300 ms sin tocar el teclado se
 * manda a la URL (`q`) — cada letra tipeada no puede disparar su propia
 * consulta a la base. Se resincroniza con la URL cuando cambia por otro lado
 * (la marca removible de `MarcasDeFiltros`, "Atrás" del navegador).
 */
export function CampoDeBusqueda() {
  const t = useT();
  const { paramsVisibles } = useNavegacion();
  const setFilter = useFilterParam();
  const desdeUrl = paramsVisibles.get("q") ?? "";

  const [valor, setValor] = useState(desdeUrl);
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValor(desdeUrl);
  }, [desdeUrl]);

  // Limpiar el temporizador en vuelo si el campo se desmonta antes de disparar.
  useEffect(
    () => () => {
      if (temporizador.current) clearTimeout(temporizador.current);
    },
    []
  );

  function cambiar(v: string) {
    setValor(v);
    if (temporizador.current) clearTimeout(temporizador.current);
    temporizador.current = setTimeout(() => {
      setFilter("q", v.trim() ? [v.trim()] : []);
    }, DEMORA_MS);
  }

  function limpiar() {
    if (temporizador.current) clearTimeout(temporizador.current);
    setValor("");
    setFilter("q", []);
  }

  return (
    <div className="relative flex-shrink-0">
      <Search
        size={14}
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
      />
      <input
        type="text"
        value={valor}
        onChange={(e) => cambiar(e.target.value)}
        placeholder={t("bandeja.buscarPlaceholder")}
        aria-label={t("bandeja.buscarPlaceholder")}
        maxLength={80}
        className="w-56 rounded-lg border border-control bg-white py-1.5 pl-8 pr-7 text-[13px] text-slate-700 shadow-sm placeholder:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
      />
      {valor && (
        <button
          type="button"
          onClick={limpiar}
          aria-label={t("bandeja.buscarLimpiar")}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <X size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
