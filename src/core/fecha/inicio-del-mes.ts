import { mesArgentino } from "@/core/fecha/dia-argentino";

/**
 * El primer instante del mes argentino de `ahora`: desde ahí se suma el gasto mensual y se fecha el
 * aviso de cada tope. Es el mismo mes con el que el acumulador de IA (0046) y el tablero cuentan, así
 * que el guardia, el aviso, /api/health y /metricas dicen el mismo número; en Vercel, que corre en
 * UTC, la cuenta con la hora del servidor arrancaba el mes tres horas tarde.
 */
export function inicioDelMes(ahora = new Date()): Date {
  return new Date(mesArgentino(ahora).inicio);
}
