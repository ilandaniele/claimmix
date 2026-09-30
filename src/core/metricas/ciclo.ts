/**
 * Las formas del ciclo de un caso y del historial mes a mes (B14, B15), y la
 * ventana de doce meses que lee el historial.
 *
 * Puro: sin base ni `server-only`. La consulta que llena estas formas vive en
 * `src/server/metrics/trayecto.ts`; acá está lo que también necesitan la
 * pantalla y el CSV.
 */

import { diaArgentino, mesArgentino, medianocheArgentina } from "@/core/fecha/dia-argentino";

/** Lo que se mide sobre un grupo de reclamos: el rango del tablero o un mes del historial. */
export type FilaDeCiclo = {
  reclamos: number;
  con_listo: number;
  mediana_horas_listo: number | null;
  con_cierre: number;
  mediana_horas_cierre: number | null;
  sin_intervencion: number;
  mensajes_por_caso: number | null;
};

export type FilaDeHistorial = FilaDeCiclo & {
  mes: string;
  completados: number;
  escalados: number;
  cerrados: number;
};

/** Cuánto se queda un caso en un estado, en promedio, y cuántas estadías lo sostienen. */
export type FilaDeCuello = { estado: string; horas_promedio: number; estancias: number };

export const MESES_DEL_HISTORIAL = 12;

/**
 * Las columnas del historial, en el orden en que las dibuja la pantalla y las
 * escribe el CSV. Son claves de diccionario: cada uno las traduce con su `t`.
 */
export const COLUMNAS_DEL_HISTORIAL = [
  "metricas.historial.col.mes",
  "metricas.historial.col.reclamos",
  "metricas.historial.col.completados",
  "metricas.historial.col.sinIntervencion",
  "metricas.historial.col.medianaListo",
  "metricas.historial.col.medianaCierre",
  "metricas.historial.col.mensajes",
  "metricas.historial.col.escalados",
  "metricas.historial.col.cerrados",
] as const;

/** `[desde, hasta)` de los últimos doce meses, el actual incluido, en horario argentino. */
export function rangoDelHistorial(ahora: Date): { desde: string; hasta: string } {
  const [anio, mes] = diaArgentino(ahora).split("-").map(Number);
  return {
    desde: medianocheArgentina(anio, mes - (MESES_DEL_HISTORIAL - 1), 1),
    hasta: mesArgentino(ahora).fin,
  };
}

/** Un mes sin reclamos es un mes con ceros, no un mes que falta en el gráfico ni en el CSV. */
export function completarHistorial(ahora: Date, filas: readonly FilaDeHistorial[]): FilaDeHistorial[] {
  const [anio, mes] = diaArgentino(ahora).split("-").map(Number);
  const porMes = new Map(filas.map((f) => [f.mes, f]));
  return Array.from({ length: MESES_DEL_HISTORIAL }, (_, i) => {
    const clave = new Date(Date.UTC(anio, mes - MESES_DEL_HISTORIAL + i, 1)).toISOString().slice(0, 7);
    return (
      porMes.get(clave) ?? {
        mes: clave,
        reclamos: 0,
        con_listo: 0,
        mediana_horas_listo: null,
        con_cierre: 0,
        mediana_horas_cierre: null,
        sin_intervencion: 0,
        mensajes_por_caso: null,
        completados: 0,
        escalados: 0,
        cerrados: 0,
      }
    );
  });
}

/** Un porcentaje entero, o null si no hay sobre qué calcularlo: cero de cero no es 0 %. */
export function porcentaje(parte: number, total: number): number | null {
  return total > 0 ? Math.round((parte / total) * 100) : null;
}

/** Un decimal, o null si no hay dato: un promedio de nada no es cero. */
export function unDecimal(n: number | null | undefined): number | null {
  return n === null || n === undefined ? null : Math.round(n * 10) / 10;
}
