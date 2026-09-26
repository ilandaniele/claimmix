/**
 * La frase de una línea que resume el caso en el detalle.
 *
 * Determinística, armada con los datos ya guardados — nunca con el `summary`
 * que devuelve el modelo. No lleva cláusula de «Falta: …»: el panel de
 * pendientes va justo arriba y ya lo dice.
 */

import type { TranslationKey } from "@/lib/i18n";
import { valorLegible } from "@/core/mensajes/valor-legible";

export interface DatosDelResumen {
  nombre: string | null;
  tipo: string | null;
  fecha: string | null;
  lugar: string | null;
  lesiones: string | null;
  hoy: string;
}

const CON_HERIDOS = new Set(["minor", "severe", "fatal"]);

/** Null cuando `tipo` todavía no está: el caso sigue en proceso. */
export function resumenDeCaso(
  d: DatosDelResumen,
  t: (k: TranslationKey) => string
): string | null {
  if (d.tipo === null) return null;

  const quien = d.nombre ?? t("case.detail.resumen.asegurado");
  let frase =
    d.tipo === "other"
      ? t("case.detail.resumen.reporta").replace("{quien}", quien)
      : t("case.detail.resumen.reportaTipo")
          .replace("{quien}", quien)
          .replace("{tipo}", t(`type.${d.tipo}` as TranslationKey).toLocaleLowerCase());

  if (d.fecha) {
    frase += t("case.detail.resumen.fecha").replace(
      "{fecha}",
      valorLegible("accident_date", d.fecha, d.hoy) ?? d.fecha
    );
  }

  if (d.lugar) {
    frase += t("case.detail.resumen.lugar").replace("{lugar}", d.lugar);
  }

  if (d.lesiones === "none") {
    frase += t("case.detail.resumen.sinHeridos");
  } else if (d.lesiones !== null && CON_HERIDOS.has(d.lesiones)) {
    frase += t("case.detail.resumen.conHeridos");
  }

  return `${frase}.`;
}
