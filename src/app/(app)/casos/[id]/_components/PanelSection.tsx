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

  /*
   * El encabezado y el cuerpo son dos bloques con su propio padding, no un
   * `p-5` con márgenes adentro.
   *
   * Es la misma forma que `CardHeader` en `_components/ui.tsx`: título a la
   * izquierda, accesorio a la derecha, y una franja de aire menor abajo que
   * arriba. Que las once secciones del detalle y las tarjetas de la bandeja
   * tengan el mismo encabezado es lo que hace que se lean como un producto y
   * no como dos pantallas parecidas.
   *
   * `justify-between` y no `gap-3`: la insignia —el nivel de riesgo de fraude,
   * el contador de confirmaciones pendientes— se va al borde derecho en vez de
   * quedar pegada al título, que es donde el ojo la busca.
   */
  return (
    <section
      aria-labelledby={idTitulo}
      className={`rounded-2xl border shadow-sm ${MARCO[tono]}`}
    >
      <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-4">
        <h2
          /*
           * `min-w-0` + `truncate`: sin eso un título largo empuja la insignia
           * fuera de la tarjeta — un hijo de flex no se encoge por debajo de su
           * contenido salvo que se le diga.
           */
          className={`min-w-0 truncate text-[15px] font-semibold tracking-tight ${TITULO[tono]}`}
          id={idTitulo}
        >
          {titulo}
        </h2>
        {accesorio ? <div className="flex-shrink-0">{accesorio}</div> : null}
      </div>
      <div className="px-5 pb-5">{children}</div>
    </section>
  );
}
