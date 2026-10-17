/**
 * Un tope leído del entorno, que cae al default si el valor no es un número.
 *
 * `parseInt("")` da NaN, y `total >= NaN` es false para cualquier total: una
 * variable vacía o mal escrita no relaja el tope, lo apaga entero y en
 * silencio. Es la misma forma que tenía el `cost_usd = 0` — un techo que no se
 * puede alcanzar nunca avisa de que no está.
 *
 * Un cero se respeta: apagar el gasto a propósito es una decisión válida. Lo
 * que no se acepta es basura, un negativo, o la variable vacía que deja un
 * workflow cuando el secreto que la llena no existe.
 *
 * Vive aparte y sin imports para que la página de configuración y /api/health
 * lean el mismo tope que el guardia sin arrastrar la base de `budget.ts`.
 */
export function readCap(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (!raw?.trim() || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/** El tope mensual de IA del proyecto entero, en USD: 200 si no está puesto, y con 0 la IA queda frenada a propósito. */
export function topeMensualDelProyecto(): number {
  return readCap(process.env.MONTHLY_BUDGET_USD, 200);
}
