/**
 * El aspecto de un chip de filtro, en un solo lugar.
 *
 * Había cuatro grupos de chips —tipo, canal, severidad, ¿es reclamo?— y cada uno
 * repetía la misma cadena de clases escrita a mano. Cuatro copias de lo mismo es
 * cuatro lugares donde el próximo cambio se aplica en tres.
 *
 * ── El cambio de fondo, que es lo que importa ───────────────────────────────
 *
 * Antes el chip INACTIVO venía relleno de gris (`bg-slate-100`). Con veinte
 * chips en pantalla —nueve tipos, tres canales, cinco severidades, tres de
 * reclamo— eso es una pared de veinte bloques grises donde el activo tiene que
 * pelear por destacarse.
 *
 * Ahora el inactivo no tiene relleno: es texto, y el fondo aparece recién al
 * pasar el mouse. Sólo el chip elegido lleva color. Se ve de un vistazo qué
 * filtros están puestos, que es la única pregunta que un filtro tiene que
 * contestar sin que lo lean.
 *
 * Las clases van escritas ENTERAS: Tailwind compila lo que encuentra literal en
 * el código, así que una armada con plantilla no existiría en la hoja de estilos.
 */

/**
 * Base común: forma, tamaño y anillo de foco.
 *
 * Se exporta porque el grupo de severidad la necesita suelta: sus chips activos
 * no llevan el violeta sino el color de su nivel, así que arman la clase con
 * esta forma más su propio color.
 */
export const CHIP_BASE =
  "flex-shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[12.5px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500";

/** Elegido. El único con relleno. */
export const CHIP_ACTIVO = `${CHIP_BASE} bg-violet-600 text-white`;

/** Sin elegir. Sin relleno hasta que el mouse encima lo pide. */
export const CHIP_INACTIVO = `${CHIP_BASE} text-slate-500 hover:bg-slate-100 hover:text-slate-900`;

export function claseChip(activo: boolean): string {
  return activo ? CHIP_ACTIVO : CHIP_INACTIVO;
}

/**
 * La etiqueta que precede a un grupo de chips («Canal:», «Severidad:»).
 *
 * Usa `rotulo` —la misma clase que los encabezados de columna y las etiquetas
 * de campo— para que se lea como rótulo y no como un chip más apagado, que es
 * exactamente cómo se leía antes.
 */
export const ROTULO_GRUPO = "rotulo mr-0.5 text-slate-400";
