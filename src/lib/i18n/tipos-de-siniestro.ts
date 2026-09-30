import { esRamoNativo, nombreDeRamoPropio, type RamoDelInquilino } from "@/core/case/ramos";
import type { ClaveDelCliente } from "@/lib/i18n/es-AR";

/**
 * La clave de i18n de un tipo que viene de la base, o `undefined` si el código
 * no lo conoce (un ramo propio de la aseguradora, o uno que ya no existe).
 * `esRamoNativo` porque el tipo es texto libre: `constructor` indexado en un
 * diccionario devuelve una función. Un ramo nuevo en `RAMOS_NATIVOS` sin su
 * `type.*` en los diccionarios no compila.
 */
export const claveDeTipo = (tipo: string): ClaveDelCliente | undefined =>
  esRamoNativo(tipo) ? `type.${tipo}` : undefined;

/** El nombre de un tipo en el idioma de la pantalla, sea nativo, propio o desconocido. */
export function nombreDeTipo(
  tipo: string,
  t: (clave: ClaveDelCliente) => string,
  ramosDelInquilino: readonly RamoDelInquilino[],
  idioma: "es-AR" | "en-US"
): string {
  const clave = claveDeTipo(tipo);
  return clave ? t(clave) : nombreDeRamoPropio(tipo, ramosDelInquilino, idioma);
}
