/**
 * El núcleo de medición de la prueba de carga.
 *
 * Vive aparte del script por dos motivos: `load-test.mts` ya es largo, y esto
 * es lo único que se puede probar sin una base de producción del otro lado —
 * un p95 mal calculado no se ve en ninguna corrida, se ve en un test.
 */

import type { Fila } from "./reporte-carga.mjs";

export interface Sample {
  ms: number;
  ok: boolean;
  /** Cuándo ARRANCÓ la operación (performance.now()). Para partir por tiempo. */
  t?: number;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i]!;
}

export function summarize(samples: Sample[]): {
  p50: number;
  p95: number;
  max: number;
  failed: number;
} {
  const ok = samples
    .filter((s) => s.ok)
    .map((s) => s.ms)
    .sort((a, b) => a - b);
  return {
    p50: percentile(ok, 50),
    p95: percentile(ok, 95),
    max: ok.at(-1) ?? 0,
    failed: samples.filter((s) => !s.ok).length,
  };
}

/**
 * `muestras` es lo que se pidió; `medidas` es sobre cuántas se calculó el p95.
 *
 * No son lo mismo y la diferencia importa: los percentiles salen sólo de las
 * que no fallaron, así que una celda que rechaza el 40% de las consultas puede
 * mostrar un p95 mejor que una sana. Con las dos columnas al lado, un p95
 * bonito calculado sobre los sobrevivientes se ve.
 */
export function fila(etiqueta: string, samples: Sample[]): Fila {
  const s = summarize(samples);
  return {
    etiqueta,
    muestras: samples.length,
    medidas: samples.length - s.failed,
    p50: s.p50,
    p95: s.p95,
    max: s.max,
    fallaron: s.failed,
  };
}

export function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

/**
 * Cuánto empeoró `despues` respecto de `antes`.
 *
 * Sin base no hay comparación, y eso NO es 1,00×. Devolvía 1 —el mejor
 * resultado posible— cuando `antes` era 0, que es exactamente lo que pasa
 * cuando fallaron todas las muestras de la línea de base: `summarize` calcula
 * el p95 sólo sobre las que salieron bien, así que una base entera caída da
 * p95 = 0. La forma imprimía «volvió a la normalidad» sobre una comparación
 * que no existió, y 1,00× es el número que nadie mira dos veces.
 */
export function veces(antes: number, despues: number): number {
  if (antes > 0) return despues / antes;
  return despues > 0 ? Number.POSITIVE_INFINITY : 1;
}

/** El ratio, o el hecho de que no hubo con qué comparar. */
export function razon(n: number): string {
  return Number.isFinite(n) ? `${n.toFixed(2)}×` : "sin línea de base";
}

/**
 * Corre `total` operaciones con a lo sumo `concurrency` en vuelo, cronometrando
 * cada una.
 *
 * Cronometrar cada operación y no el lote entero es el punto: el total dice
 * cuántas por segundo, y eso no es lo que siente el analista. Lo que siente es
 * su propia consulta haciendo cola detrás de las de todos los demás, y eso
 * sólo aparece en la cola de la distribución.
 */
export async function measure(
  total: number,
  concurrency: number,
  op: () => Promise<void>
): Promise<Sample[]> {
  const samples: Sample[] = [];
  const obreros = Math.min(concurrency, total);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (next++ >= total) return;
      const started = performance.now();
      try {
        await op();
        samples.push({ ms: performance.now() - started, ok: true, t: started });
      } catch {
        samples.push({ ms: performance.now() - started, ok: false, t: started });
      }
    }
  }

  await calentar(obreros, op);
  await Promise.all(Array.from({ length: obreros }, worker));
  return samples;
}

/**
 * Una vuelta a la par por cada trabajador, sin cronometrar.
 *
 * El driver es neon-http sobre HTTP/1.1: cada consulta en vuelo necesita su
 * propio socket, así que exactamente `concurrency` muestras de cada medición
 * pagaban TCP+TLS contra Neon y el resto reusaba la conexión. Como el total de
 * muestras es fijo, la fracción contaminada crece con la concurrencia — y la
 * tabla de 1 / 5 / 20 analistas terminaba comparando una columna con la
 * conexión caliente contra una con la conexión fría, y llamándole al servidor
 * un costo que fabricaba el propio arnés.
 *
 * Abrir las conexiones antes de arrancar el cronómetro las deja calientes para
 * todas las columnas por igual.
 */
async function calentar(n: number, op: () => Promise<void>): Promise<void> {
  await Promise.all(
    Array.from({ length: n }, async () => {
      try {
        await op();
      } catch {
        // Un error acá lo vuelve a encontrar la medición, y ahí sí se cuenta.
      }
    })
  );
}

/** Lo mismo, pero por tiempo: la resistencia no se mide en operaciones. */
export async function measureFor(
  durationMs: number,
  concurrency: number,
  op: () => Promise<void>
): Promise<Sample[]> {
  const samples: Sample[] = [];
  await calentar(concurrency, op);
  const fin = performance.now() + durationMs;

  async function worker(): Promise<void> {
    while (performance.now() < fin) {
      const started = performance.now();
      try {
        await op();
        samples.push({ ms: performance.now() - started, ok: true, t: started });
      } catch {
        samples.push({ ms: performance.now() - started, ok: false, t: started });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return samples;
}

/**
 * Partir muestras por TIEMPO, no por posición en el arreglo.
 *
 * La resistencia cortaba los tercios por índice, y la cantidad de muestras por
 * unidad de tiempo es inversamente proporcional a la latencia: un tramo que
 * tarda diez veces más aporta diez veces menos muestras. O sea que la
 * degradación achicaba su propia representación justo en la proporción en que
 * degradaba — con los últimos 25 segundos de tres minutos degradados, el
 * «último tercio» juntaba un 5% de muestras lentas y la deriva salía 1,00×.
 *
 * Que se acumule y estalle al final es exactamente lo que esta forma existe
 * para encontrar.
 */
export function porTiempo(samples: Sample[], partes: number): Sample[][] {
  const conReloj = samples.filter((s) => s.t !== undefined);
  if (conReloj.length === 0) return Array.from({ length: partes }, () => []);

  // Con reduce y no `Math.min(...arreglo)`: una corrida de media hora junta
  // decenas de miles de muestras y esparcirlas como argumentos revienta la pila.
  let desde = Infinity;
  let hasta = -Infinity;
  for (const s of conReloj) {
    if (s.t! < desde) desde = s.t!;
    if (s.t! > hasta) hasta = s.t!;
  }
  const tramo = (hasta - desde) / partes || 1;

  const cortes: Sample[][] = Array.from({ length: partes }, () => []);
  for (const s of conReloj) {
    const i = Math.min(partes - 1, Math.floor((s.t! - desde) / tramo));
    cortes[i]!.push(s);
  }
  return cortes;
}
