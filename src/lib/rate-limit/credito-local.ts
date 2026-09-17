/**
 * Crédito local para el limitador que reserva de a lotes.
 *
 * `checkRateLimitPostgres` con `lote` carga varios cupos de una sola escritura
 * (`hits = hits + lote`). Esta pieza es la que gasta ese lote en memoria, pedido
 * a pedido, para que un sondeo cada cinco segundos no escriba en la base cada
 * cinco segundos.
 *
 * La ventana es la misma que ya usa `postgres.ts`: se deriva del reloj, no de
 * cuándo se pidió el lote, así que todas las instancias caen en la misma sin
 * coordinarse. Y por eso mismo, lo que sobra de un lote NO pasa a la ventana
 * siguiente: `gastarCredito` devuelve `null` en cuanto cambia el `windowStart`,
 * aunque el lote anterior tuviera crédito sin usar.
 *
 * Ese descarte es todo el argumento de seguridad. El lote ya está cargado en la
 * base — la escritura que lo reservó ya sumó `lote` al contador remoto, pase lo
 * que pase después acá. Gastarlo de más no existe: como mucho se gasta de
 * menos, si la ventana cambia antes de agotarlo. El limitador entonces sólo
 * puede terminar más estricto que el límite configurado, nunca más laxo.
 *
 * Misma forma de descarte por capacidad que `memory.ts`: un Map con tope, y al
 * llegar al tope se tira la entrada más vieja para hacer lugar.
 */

const MAX_KEYS = 10_000;

export interface Reserva {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

interface LotePendiente {
  windowStart: number;
  /** El contador remoto tal cual quedó después de sumar el lote entero. */
  hitsRemoto: number;
  limite: number;
  lote: number;
  /** Cuántos de los `lote` créditos ya se entregaron localmente. */
  usados: number;
}

// Un lote por clave — sobrevive entre pedidos de la misma instancia, se pierde
// en cold start como cualquier estado en memoria. No importa: al perderse, el
// próximo pedido simplemente vuelve a escribir y arranca un lote nuevo.
const store = new Map<string, LotePendiente>();

/**
 * Gasta un crédito del lote vigente para `clave`, sin tocar la base.
 *
 * Devuelve `null` cuando no hay lote para esta ventana (todavía no se reservó
 * uno, se agotó, o la ventana cambió) — ahí es cuando quien llama tiene que ir
 * a la base y, si consigue un lote nuevo, anotarlo con `anotarReserva`.
 */
export function gastarCredito(clave: string, ventanaMs: number): Reserva | null {
  const now = Date.now();
  const windowStart = Math.floor(now / ventanaMs) * ventanaMs;
  const resetAt = windowStart + ventanaMs;

  const entry = store.get(clave);
  if (!entry || entry.windowStart !== windowStart) {
    // Sin lote vigente. Si había uno de la ventana anterior, se descarta acá
    // mismo con sólo no usarlo: es la parte que sostiene la garantía de arriba.
    return null;
  }

  if (entry.usados >= entry.lote) return null; // lote agotado, hace falta uno nuevo

  entry.usados += 1;
  // El hit que le corresponde a ESTE pedido, no al lote entero: el lote sumó
  // `lote` de una vez, así que el pedido N-ésimo del lote vale
  // `hitsRemoto - lote + N` en la cuenta real de la base.
  const hitsDeEstePedido = entry.hitsRemoto - entry.lote + entry.usados;

  return {
    allowed: hitsDeEstePedido <= entry.limite,
    remaining: Math.max(0, entry.limite - hitsDeEstePedido),
    resetAt,
  };
}

/**
 * Anota el lote recién reservado en la base para que `gastarCredito` lo use.
 *
 * @param hits  El contador que devolvió `checkRateLimitPostgres`: ya incluye
 *              el lote entero recién sumado.
 * @param lote  Cuánto se sumó de una vez.
 */
export function anotarReserva(
  clave: string,
  ventanaMs: number,
  hits: number,
  limite: number,
  lote: number
): void {
  const now = Date.now();
  const windowStart = Math.floor(now / ventanaMs) * ventanaMs;

  // Mismo tope y misma forma de descartar que `memory.ts`: no hace falta un
  // segundo esquema de LRU para esto.
  if (store.size >= MAX_KEYS) {
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) {
      store.delete(firstKey);
    }
  }

  store.set(clave, { windowStart, hitsRemoto: hits, limite, lote, usados: 0 });
}

/**
 * Borra todo el crédito reservado. Sólo para tests.
 */
export function limpiarCreditos(): void {
  store.clear();
}
