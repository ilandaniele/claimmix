/**
 * El costo de IA por caso de un mes: mediana y p95 de lo que gastó cada caso real.
 *
 * Puro y sin imports a propósito: lo usa `statement.ts` en el servidor y lo
 * prueba un test sin base. La consulta le pasa un número por caso (la suma del
 * gasto de ese caso en el mes) y acá sólo se resume.
 */

export type CostoPorCaso = {
  /** Casos reales del mes con algún gasto de IA anotado. */
  cases: number;
  median_usd: number;
  p95_usd: number;
};

const redondear = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * Resume el costo de cada caso.
 *
 * Acepta el arreglo o su texto JSON: según el driver, `json_agg` llega ya
 * parseado o como string. Devuelve `undefined` si no hay ningún caso con gasto,
 * para que la pantalla diga «sin datos» en vez de mostrar ceros.
 *
 * Mediana y p95 interpolan entre vecinos, como `percentile_cont`.
 */
export function costoPorCaso(crudo: unknown): CostoPorCaso | undefined {
  let valores = crudo;
  if (typeof valores === "string") {
    try {
      valores = JSON.parse(valores);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(valores)) return undefined;

  const costos = valores
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    .sort((a, b) => a - b);
  if (costos.length === 0) return undefined;

  const percentil = (p: number): number => {
    const pos = p * (costos.length - 1);
    const abajo = Math.floor(pos);
    const arriba = Math.ceil(pos);
    return redondear(costos[abajo] + (costos[arriba] - costos[abajo]) * (pos - abajo));
  };

  return { cases: costos.length, median_usd: percentil(0.5), p95_usd: percentil(0.95) };
}
