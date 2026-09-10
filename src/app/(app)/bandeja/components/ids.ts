/**
 * Los ids que dos componentes de la bandeja tienen que compartir.
 *
 * Vivían adentro de `FilterTabs`, que era el `role="tablist"` de los estados y
 * apuntaba con `aria-controls` a la lista. Las pestañas se fueron al panel de
 * filtros —contaban un estado suelto mientras las baldosas agrupaban, así que
 * tres de las cinco decían 0 sobre 483 casos— y el id se quedó: la lista sigue
 * necesitando uno para que la anuncien.
 */

/** El contenedor que scrollea con los siniestros. */
export const ID_PANEL_DE_LA_LISTA = "lista-de-siniestros";
