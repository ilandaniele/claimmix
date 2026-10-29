// Sin "use client": la importa la página del servidor, y un valor exportado de un módulo
// cliente le llegaría como referencia y no como arreglo (como bandeja/per-page.ts).
import { Activity, Brain, CheckCircle2, ClipboardList, ListChecks, Settings2, SlidersHorizontal, Layers } from "lucide-react";

import type { ClaveDelCliente } from "@/lib/i18n";

/**
 * La etiqueta es una CLAVE, no un texto: la lista se arma una sola vez cuando
 * carga el módulo, y ahí todavía no hay locale ni hook. Traducir en el `map`,
 * que sí corre dentro del componente, es lo que hace que las solapas cambien
 * de idioma sin recargar.
 */
export const TABS = [
  { id: "modelos", clave: "consola.tab.modelos", icon: Settings2 },
  { id: "campos", clave: "consola.tab.campos", icon: SlidersHorizontal },
  { id: "ramos", clave: "consola.tab.ramos", icon: ListChecks },
  { id: "formulario", clave: "consola.tab.formulario", icon: ClipboardList },
  { id: "reglas", clave: "consola.tab.reglas", icon: ListChecks },
  { id: "ejemplos", clave: "consola.tab.ejemplos", icon: CheckCircle2 },
  { id: "entrenamiento", clave: "consola.tab.entrenamiento", icon: Brain },
  { id: "uso", clave: "consola.tab.uso", icon: Activity },
  { id: "lote", clave: "consola.tab.lote", icon: Layers },
  { id: "trabajo", clave: "consola.tab.trabajo", icon: ClipboardList },
  { id: "base", clave: "consola.tab.base", icon: Brain },
] as const satisfies readonly { id: string; clave: ClaveDelCliente; icon: unknown }[];

export type TabId = (typeof TABS)[number]["id"];

/** El `tab` de la dirección, sólo si es una de las pestañas: un valor desconocido, vacío o repetido (arreglo) se ignora. */
export function tabDeLaUrl(v: string | string[] | undefined): TabId | undefined {
  return typeof v === "string" ? TABS.find((t) => t.id === v)?.id : undefined;
}
