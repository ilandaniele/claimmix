/**
 * El ancho de una barra de progreso, como clase y no como atributo `style`.
 *
 * ── Por qué no `style={{ width: … }}` ───────────────────────────────────────
 *
 * Porque eso obliga a `style-src 'unsafe-inline'` en la CSP, y con esa
 * directiva puesta cualquier punto de inyección de HTML permite meter CSS: se
 * pueden exfiltrar datos con selectores de atributo más `background-image`,
 * tapar botones, o dibujar encima de lo que la persona cree que está
 * apretando. Con `script-src` ya cerrado, el CSS inyectado es la palanca que
 * queda.
 *
 * Un nonce NO alcanza: los nonces valen para bloques `<style>`, no para
 * atributos `style` del marcado. Se comprobó en el navegador — con
 * `style-src 'self' 'nonce-…'` el atributo queda en el DOM y no se aplica, así
 * que la barra mide lo que mida su contenedor en vez de su porcentaje. Silencioso
 * y equivocado, que es la peor combinación.
 *
 * ── Por qué se redondea a 5% ────────────────────────────────────────────────
 *
 * Tailwind necesita que la clase aparezca LITERAL en el código para compilarla,
 * así que un `w-[${pct}%]` no existiría en la hoja de estilos. Veintiún clases
 * escritas a mano sí.
 *
 * El costo es visual y mínimo: una barra de confianza redondeada al 5% más
 * cercano. El número exacto se sigue mostrando al lado en texto, que es de
 * donde alguien lee un valor cuando le importa el valor.
 */

/** De 0 a 100, redondeado al 5% más cercano. Las 21 clases van literales. */
const ANCHOS: Record<number, string> = {
  0: "w-0",
  5: "w-[5%]",
  10: "w-[10%]",
  15: "w-[15%]",
  20: "w-[20%]",
  25: "w-[25%]",
  30: "w-[30%]",
  35: "w-[35%]",
  40: "w-[40%]",
  45: "w-[45%]",
  50: "w-[50%]",
  55: "w-[55%]",
  60: "w-[60%]",
  65: "w-[65%]",
  70: "w-[70%]",
  75: "w-[75%]",
  80: "w-[80%]",
  85: "w-[85%]",
  90: "w-[90%]",
  95: "w-[95%]",
  100: "w-full",
};

/**
 * La clase de ancho para un porcentaje.
 *
 * Acepta cualquier número —incluido `NaN`, que sale de un `Number(undefined)`
 * en el borde— y siempre devuelve una clase válida: una barra que no se dibuja
 * es mejor que una que se dibuja mal.
 */
export function anchoDeBarra(porcentaje: number): string {
  if (!Number.isFinite(porcentaje)) return ANCHOS[0];
  const acotado = Math.min(100, Math.max(0, porcentaje));
  const alCinco = Math.round(acotado / 5) * 5;
  return ANCHOS[alCinco] ?? ANCHOS[0];
}
