/**
 * General-purpose utilities for ClaimMix.
 */

import { ZONA_ARGENTINA } from "@/core/fecha/dia-argentino";
import type { TranslationKey } from "@/lib/i18n/es-AR";
import type { Locale } from "@/lib/i18n";

/**
 * Merge class names conditionally (Tailwind-friendly).
 * Lightweight alternative to clsx — avoids an extra dependency for W1.
 */
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Una fecha con hora, escrita en el idioma de quien mira.
 *
 * El idioma cambia; la ZONA NO. Un siniestro que entró a las 18:09 en Buenos
 * Aires entró a las 18:09 aunque el analista lea la pantalla en inglés: si la
 * zona siguiera al idioma, el mismo dato mostraría otra hora según quién lo
 * abre, y eso no es traducir sino falsear. Por eso `timeZone` está fijo y el
 * primer argumento del formateador no.
 *
 * @example
 * formatDate("2024-01-15T12:00:00Z", "es-AR") // "15/01/2024, 09:00 a. m."
 * formatDate("2024-01-15T12:00:00Z", "en-US") // "01/15/2024, 09:00 AM"
 */
export function formatDate(
  date: string | Date,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(locale, {
    timeZone: ZONA_ARGENTINA,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...options,
  });
}

/**
 * Dibuja una columna `date` de Postgres, que no tiene hora ni zona.
 *
 * `formatDate` no sirve para esto, y el error es de los que no se notan: una
 * columna `date` vuelve como "2025-07-28", `new Date` la lee como medianoche
 * UTC, y formatearla en horario argentino la corre tres horas para atrás — o
 * sea al día anterior, a las nueve de la noche. Una póliza que arranca el 1° de
 * enero se dibujaba como 31 de diciembre, con una hora que nadie cargó nunca.
 *
 * Acá no hay conversión ninguna: se parte el texto y se reordena. Una fecha sin
 * hora no tiene zona horaria, así que cualquier cosa que la mueva está mal, y la
 * forma más segura de no moverla es no construir un `Date`.
 *
 * @example
 * formatDateOnly("2026-01-01", "es-AR") // "01/01/2026"
 * formatDateOnly("2026-01-31", "en-US") // "01/31/2026"
 */
export function formatDateOnly(date: string, locale: Locale): string {
  const partes = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  // Si no tiene la forma de una fecha sola, se devuelve tal cual: es preferible
  // mostrar el valor crudo que inventarle un día.
  if (!partes) return date;
  const [, anio, mes, dia] = partes;
  /*
   * El orden lo decide el idioma, y para eso hay que armar la fecha — pero
   * armada en UTC y formateada en UTC, que es la única forma de reordenarla sin
   * moverla. Construirla en la zona local o formatearla en la argentina es
   * exactamente el bug que esta función existe para no tener.
   */
  return new Date(Date.UTC(Number(anio), Number(mes) - 1, Number(dia))).toLocaleDateString(
    locale,
    { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" }
  );
}

/**
 * Hace cuánto entró un siniestro, en el idioma de quien mira.
 *
 * El traductor es obligatorio y no opcional a propósito. Esto devolvía «Hace
 * 3d» en duro, así que la columna «Antigüedad» seguía en castellano con el
 * producto entero en inglés — y era la última que quedaba, porque un valor por
 * omisión hace que la próxima llamada que se olvide de pasarlo tampoco falle.
 * Con el parámetro exigido, el compilador las encuentra todas.
 *
 * Los cortes —minuto, hora, día— y los textos en castellano quedan idénticos a
 * como estaban; lo único que cambia es de dónde salen.
 */
export function formatAge(
  createdAt: string,
  t: (key: TranslationKey) => string
): string {
  const created = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  /*
   * El número va por `{n}` y no concatenado, porque en inglés va adelante
   * («3d ago») y en castellano atrás («Hace 3d»). Concatenar un prefijo
   * traducido funciona en un idioma y se rompe en el otro.
   */
  const con = (key: TranslationKey, n: number) => t(key).replace("{n}", String(n));

  if (diffMinutes < 1) return t("age.now");
  if (diffMinutes < 60) return con("age.minutes", diffMinutes);
  if (diffHours < 24) return con("age.hours", diffHours);
  return con("age.days", diffDays);
}

/**
 * Truncate a string to maxLength characters, appending "..." if truncated.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + "...";
}

/**
 * Un monto en dólares, escrito igual en todo el producto.
 *
 * Estaba implementado tres veces con dos locales distintos, y el peor caso no
 * era entre pantallas sino DENTRO de una: en métricas convivían un
 * `formatNumber` en `es-AR` y un `formatUsd` en `en-US`, así que dos tarjetas
 * contiguas mostraban `1.234.567` y `$1,234.56` — separador de miles al revés
 * en la misma fila.
 *
 * Gana `es-AR`, que es el idioma del resto del producto.
 *
 * `precision` existe porque hay dos usos con necesidades opuestas: la
 * facturación muestra montos de decenas o cientos y dos decimales alcanzan; el
 * costo de IA por llamada es de milésimas y con dos decimales todo se ve
 * `$0,01`. No es configurabilidad especulativa: son los dos casos que hay.
 */
export function formatUsd(value: number, precision: 2 | 4 = 2): string {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: precision,
  }).format(value);
}
