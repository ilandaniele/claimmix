/**
 * El motivo con que se descartó un caso, si es del modelo.
 *
 * Hasta hace poco, cuando el modelo descartaba sin decir por qué, el worker
 * guardaba un texto fijo —«El clasificador de IA determinó que este email no es
 * un reclamo de seguro»— que después se leía como si lo hubiera dicho el
 * modelo. Hoy la columna queda nula en ese caso, pero las filas viejas pueden
 * conservar el texto, y la pantalla no tiene que mostrarlo como un motivo.
 *
 * Devuelve `null` si no hay motivo propio, y quien llama pone su texto por
 * defecto. Es pura: la usan la lista y el detalle, del lado cliente y servidor.
 */

const PREFIJO_HISTORICO = "El clasificador de IA determinó";

export function motivoPropioDelDescarte(r: string | null | undefined): string | null {
  const motivo = r?.trim();
  if (!motivo || motivo.startsWith(PREFIJO_HISTORICO)) return null;
  return motivo;
}
