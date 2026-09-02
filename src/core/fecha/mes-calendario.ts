/**
 * Un mes de calendario —`"2026-09"`— escrito para que lo lea una persona.
 *
 * Vive aparte de `dia-argentino.ts` a propósito, aunque las dos sean de fechas:
 * aquel módulo existe porque el servidor corre en UTC y el negocio vive en
 * Buenos Aires, y todo lo que tiene adentro corrige ese corrimiento. Éste hace
 * lo contrario y también a propósito.
 *
 * `"2026-09"` no es un instante: es una etiqueta de período que ya viene
 * decidida —viaja en la URL y se compara contra la base como texto—. Armarla
 * como el primero del mes en horario argentino y después formatearla en otra
 * zona la correría al mes ANTERIOR. Se construye en UTC y se formatea en UTC,
 * que es la única forma de no moverla.
 *
 * El IDIOMA sí entra por parámetro: cómo se escribe «septiembre de 2026» lo
 * decide quien mira.
 *
 * Estaba escrita a mano adentro de `admin/facturacion/page.tsx`, y la pantalla
 * hermana —`admin/cartera`— mostraba el mismo valor crudo, «2026-09». Copiarla
 * era la otra opción, y dos copias de una regla de fechas es exactamente cómo
 * una de las dos se queda vieja.
 */
export function mesDeCalendario(mes: string, locale: string): string {
  const [anio, m] = mes.split("-");
  const fecha = new Date(Date.UTC(Number(anio), Number(m) - 1, 1));
  return fecha.toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
