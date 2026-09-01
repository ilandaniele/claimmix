/**
 * El hueco: un dato que no está.
 *
 * Estaba escrito de cuatro maneras en tres archivos —`text-slate-400 text-sm`,
 * `text-slate-300 text-xs`, `text-slate-500`, y un `"—"` suelto heredando el
 * color de la celda—, así que en una tabla llena de huecos algunos guiones
 * pesaban como si fueran contenido y otros casi no se veían.
 *
 * Uno solo, y el más tenue de todos: la ausencia no tiene que competir con lo
 * que sí está.
 *
 * En modo oscuro `globals.css` pisa `text-slate-300` con un gris apagado. Sin
 * eso, este mismo guión salía casi blanco sobre la tarjeta oscura y era lo más
 * brillante de la tabla — exactamente al revés de lo que se busca.
 */
export function Vacio() {
  return (
    <span className="text-slate-300" aria-label="Sin dato">
      —
    </span>
  );
}
