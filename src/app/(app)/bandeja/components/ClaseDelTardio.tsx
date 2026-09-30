/**
 * Qué pide el mensaje que llegó después de que el agente terminó (B3).
 *
 * `null` es «sin clasificar»: el modelo falló o no se llamó. Una clase que el
 * diccionario no conoce no se muestra.
 */
"use client";

import { useT } from "@/lib/i18n/LocaleContext";
import type { ClaveDelCliente } from "@/lib/i18n";

export function ClaseDelTardio({ tipo, resumen }: { tipo: string | null; resumen?: string | null }) {
  const t = useT();
  const etiqueta = t(`tardio.tipo.${tipo ?? "sin_clasificar"}` as ClaveDelCliente);
  if (!etiqueta) return null;
  return (
    <span
      title={resumen ?? undefined}
      className="inline-flex items-center whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700"
    >
      {etiqueta}
    </span>
  );
}
