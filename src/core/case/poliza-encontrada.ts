/**
 * ¿Podemos dar por sabido el número de póliza que encontramos nosotros?
 *
 * El buscador puede llegar a la póliza por el DNI, sin que la persona haya
 * dicho nunca el número. Cuando eso pasa, seguir pidiéndoselo es pedirle un
 * dato que está en nuestra propia base — que es exactamente lo que hace un
 * formulario, y lo que este producto vino a reemplazar.
 *
 * Salió de un ensayo: `polizas_por_dni` devolvía POL-8812-R y la respuesta
 * siguiente arrancaba con «El número de póliza (por ejemplo POL-12345)». El
 * agente no se equivocaba: los faltantes se anotan antes de que el worker
 * busque en la base, así que el número le llegaba marcado como faltante.
 *
 * Trece líneas de regla, acá afuera, porque adentro del worker vivían entre
 * consultas y no las probaba nadie.
 */

/** Lo mínimo que hace falta saber de una póliza para decidir. */
export interface PolizaCandidata {
  policyId: string;
  policyNumber: string;
  confidence: number;
}

/**
 * La póliza cuyo número podemos completar solos, o `null` si hay que preguntar.
 *
 * @param numeroQueDijo  El número que dio la persona, si dio alguno.
 * @param encontradas    Lo que devolvió el buscador, ya ordenado.
 */
export function polizaParaCompletar(
  numeroQueDijo: string | null | undefined,
  encontradas: readonly PolizaCandidata[]
): PolizaCandidata | null {
  /*
   * Si lo dijo, manda lo que dijo.
   *
   * Aunque no coincida con lo que encontramos: un número equivocado es una
   * conversación con la persona, no algo para corregirle por atrás. Pisarlo en
   * silencio haría que el caso diga una cosa y el asegurado recuerde otra.
   */
  if (numeroQueDijo && numeroQueDijo.trim() !== "") return null;

  /*
   * Sólo cuando hay UNA.
   *
   * Con dos pólizas a nombre de la misma persona no sabemos bajo cuál viene el
   * siniestro —el auto o la casa—, y ahí preguntar es lo correcto. Elegir la
   * primera sería adivinar y escribirlo como si lo supiéramos.
   */
  if (encontradas.length !== 1) return null;

  const unica = encontradas[0]!;
  // Una fila sin número no sirve para completar nada.
  if (!unica.policyNumber || unica.policyNumber.trim() === "") return null;

  return unica;
}
