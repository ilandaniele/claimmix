/**
 * Un panel con título, de los que arman el detalle de un caso.
 *
 * Estaba escrito once veces en `page.tsx`, y no era sólo repetición: cada copia
 * tenía que acordarse de que el `aria-labelledby` del `<section>` coincidiera
 * con el `id` del `<h2>`. Once pares escritos a mano, y si uno se escribe mal el
 * lector de pantalla anuncia la sección sin nombre — un error que no se ve
 * mirando la pantalla, así que nadie lo encuentra.
 *
 * Acá el `id` se escribe una sola vez y los dos atributos salen de él.
 */

import type { ReactNode } from "react";

/**
 * El color del panel dice algo, no decora: `peligro` y `precaucion` son los dos
 * niveles de alerta de fraude, `exito` es la acción de sincronizar al core.
 */
export type TonoPanel = "neutro" | "peligro" | "precaucion" | "atencion" | "exito";

const MARCO: Record<TonoPanel, string> = {
  neutro: "border-slate-200 bg-white",
  peligro: "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30",
  precaucion: "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30",
  atencion: "border-yellow-100 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/20",
  exito: "border-emerald-200 bg-emerald-50",
};

const TITULO: Record<TonoPanel, string> = {
  neutro: "text-slate-900",
  peligro: "text-red-900 dark:text-red-100",
  precaucion: "text-amber-900 dark:text-amber-100",
  atencion: "text-amber-900 dark:text-amber-100",
  exito: "text-emerald-900",
};

interface PanelSectionProps {
  /** Identificador de la sección. De acá salen el `aria-labelledby` y el `id` del encabezado. */
  id: string;
  titulo: ReactNode;
  tono?: TonoPanel;
  /** Va al lado del título, en la misma línea. Para insignias. */
  accesorio?: ReactNode;
  children: ReactNode;
}

export function PanelSection({
  id,
  titulo,
  tono = "neutro",
  accesorio,
  children,
}: PanelSectionProps) {
  const idTitulo = `${id}-heading`;
  // Sin insignia al lado, el margen va en el propio encabezado: así el DOM que
  // sale es el mismo que había antes de que esto fuera un componente.
  const encabezado = (
    <h2
      className={`text-sm font-semibold ${TITULO[tono]}${accesorio ? "" : " mb-4"}`}
      id={idTitulo}
    >
      {titulo}
    </h2>
  );

  return (
    <section
      aria-labelledby={idTitulo}
      className={`rounded-xl border p-5 shadow-sm ${MARCO[tono]}`}
    >
      {accesorio ? (
        <div className="flex items-center gap-3 mb-3">
          {encabezado}
          {accesorio}
        </div>
      ) : (
        encabezado
      )}
      {children}
    </section>
  );
}
