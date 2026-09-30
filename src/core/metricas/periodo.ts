/**
 * El período que se mira: el vocabulario que comparten el asistente y el
 * tablero, y el rango `[desde, hasta)` que le corresponde en horario argentino.
 *
 * Puro: sin `server-only` ni base. Lo usa `IntencionSchema` (lo que el modelo
 * puede pedir) y `/metricas?periodo=` (lo que la persona elige con un enlace).
 */

import { medianocheArgentina, diaArgentino, mesArgentino } from "@/core/fecha/dia-argentino";

export const PERIODOS = [
  "hoy",
  "ayer",
  "esta_semana",
  "este_mes",
  "mes_pasado",
  "este_anio",
  "anio_pasado",
  "ultimos_30_dias",
] as const;

export type Periodo = (typeof PERIODOS)[number];

/** Los que ofrece el tablero: los que dan una foto de gestión, no un día suelto. */
export const PERIODOS_DEL_TABLERO = [
  "esta_semana",
  "este_mes",
  "mes_pasado",
  "ultimos_30_dias",
  "este_anio",
] as const satisfies readonly Periodo[];

export type PeriodoDelTablero = (typeof PERIODOS_DEL_TABLERO)[number];

export const PERIODO_POR_DEFECTO: PeriodoDelTablero = "este_mes";

/** El período de un parámetro de URL o de un cuerpo; lo que no sea del tablero cae al de siempre. */
export function periodoDe(valor: unknown): PeriodoDelTablero {
  return PERIODOS_DEL_TABLERO.find((p) => p === valor) ?? PERIODO_POR_DEFECTO;
}

/** Una fecha `AAAA-MM-DD` corrida `delta` días, en calendario (no en instante). */
function diaCorrido(ymd: string, delta: number): [number, number, number] {
  const [anio, mes, dia] = ymd.split("-").map(Number);
  const d = new Date(Date.UTC(anio, mes - 1, dia + delta));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

/** El lunes de la semana que contiene esa fecha, en calendario. */
function lunesDeLaSemana(ymd: string): [number, number, number] {
  const [anio, mes, dia] = ymd.split("-").map(Number);
  const diaDeLaSemana = new Date(Date.UTC(anio, mes - 1, dia)).getUTCDay(); // 0=domingo
  const desdeElLunes = (diaDeLaSemana + 6) % 7;
  return diaCorrido(ymd, -desdeElLunes);
}

/**
 * El rango `[desde, hasta)` de un período, en horario argentino.
 *
 * Devuelve instantes UTC listos para `gte(cases.created_at, desde)` y
 * `lt(cases.created_at, hasta)` — el mismo par que ya arma `mesArgentino`.
 */
export function rangoDelPeriodo(p: Periodo, ahora: Date): { desde: string; hasta: string } {
  const hoy = diaArgentino(ahora);
  const [anio, mes, dia] = hoy.split("-").map(Number);
  const manana = diaCorrido(hoy, 1);

  switch (p) {
    case "hoy":
      return { desde: medianocheArgentina(anio, mes, dia), hasta: medianocheArgentina(...manana) };
    case "ayer": {
      const [a, m, d] = diaCorrido(hoy, -1);
      return { desde: medianocheArgentina(a, m, d), hasta: medianocheArgentina(anio, mes, dia) };
    }
    case "esta_semana": {
      const [a, m, d] = lunesDeLaSemana(hoy);
      return { desde: medianocheArgentina(a, m, d), hasta: medianocheArgentina(...manana) };
    }
    case "este_mes": {
      const { inicio, fin } = mesArgentino(ahora);
      return { desde: inicio, hasta: fin };
    }
    case "mes_pasado":
      return {
        desde: medianocheArgentina(anio, mes - 1, 1),
        hasta: medianocheArgentina(anio, mes, 1),
      };
    case "este_anio":
      return { desde: medianocheArgentina(anio, 1, 1), hasta: medianocheArgentina(anio + 1, 1, 1) };
    case "anio_pasado":
      return { desde: medianocheArgentina(anio - 1, 1, 1), hasta: medianocheArgentina(anio, 1, 1) };
    case "ultimos_30_dias": {
      const [a, m, d] = diaCorrido(hoy, -30);
      return { desde: medianocheArgentina(a, m, d), hasta: medianocheArgentina(...manana) };
    }
  }
}
