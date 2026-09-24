/**
 * La serie de actividad de /metricas: reclamos abiertos, WhatsApps y mails
 * atendidos, por día (30), por mes (12) o por año (5).
 *
 * La base devuelve sólo los períodos que tuvieron casos. Acá se arma la ventana
 * entera y se rellenan los huecos con cero: un día sin casos que no aparece se
 * lee como si el gráfico lo salteara, no como un día tranquilo.
 *
 * Los períodos son argentinos, igual que en el SQL que los agrupa. Si la
 * ventana se calculara en UTC, entre las 21 y las 24 el último período sería
 * mañana y quedaría vacío.
 */

import { diaArgentino, medianocheArgentina } from "@/core/fecha/dia-argentino";

export const UNIDADES = ["dia", "mes", "anio"] as const;
export type Unidad = (typeof UNIDADES)[number];

export interface PuntoSerie {
  clave: string;
  reclamos: number;
  whatsapps: number;
  mails: number;
}

const LARGO: Record<Unidad, number> = { dia: 30, mes: 12, anio: 5 };

/**
 * Cómo agrupa y rotula la base cada unidad. La clave que sale de `fmt` es la
 * misma que arma `completarSerie`, y por eso el cruce es por igualdad de texto.
 */
export const FORMATO_DE: Record<
  Unidad,
  { trunc: "day" | "month" | "year"; fmt: "YYYY-MM-DD" | "YYYY-MM" | "YYYY" }
> = {
  dia: { trunc: "day", fmt: "YYYY-MM-DD" },
  mes: { trunc: "month", fmt: "YYYY-MM" },
  anio: { trunc: "year", fmt: "YYYY" },
};

/** Lo que llega por `?serie=`; cualquier otra cosa, incluida una lista, es mes. */
export function unidadDe(valor: string | string[] | undefined): Unidad {
  return UNIDADES.find((u) => u === valor) ?? "mes";
}

/**
 * El primer período de la ventana, como año, mes y día de calendario. Los
 * negativos y desbordes los normaliza `Date.UTC`.
 */
function primero(unidad: Unidad, ahora: Date): [number, number, number] {
  const [a, m, d] = diaArgentino(ahora).split("-").map(Number);
  if (unidad === "dia") return [a, m, d - (LARGO.dia - 1)];
  if (unidad === "mes") return [a, m - (LARGO.mes - 1), 1];
  return [a - (LARGO.anio - 1), 1, 1];
}

/** Desde qué instante hay que leer casos para cubrir la ventana, en ISO (UTC). */
export function desdeDe(unidad: Unidad, ahora: Date = new Date()): string {
  return medianocheArgentina(...primero(unidad, ahora));
}

/** Los 30, 12 o 5 períodos en orden, terminando en el de hoy, con ceros donde no hubo nada. */
export function completarSerie(
  unidad: Unidad,
  ahora: Date,
  filas: PuntoSerie[]
): PuntoSerie[] {
  const [a, m, d] = primero(unidad, ahora);
  const porClave = new Map(filas.map((f) => [f.clave, f]));
  return Array.from({ length: LARGO[unidad] }, (_, i) => {
    const fecha = new Date(
      Date.UTC(
        a + (unidad === "anio" ? i : 0),
        m - 1 + (unidad === "mes" ? i : 0),
        d + (unidad === "dia" ? i : 0)
      )
    );
    // El largo del formato es el largo de la clave: 10, 7 o 4 caracteres.
    const clave = fecha.toISOString().slice(0, FORMATO_DE[unidad].fmt.length);
    const fila = porClave.get(clave);
    return {
      clave,
      reclamos: fila?.reclamos ?? 0,
      whatsapps: fila?.whatsapps ?? 0,
      mails: fila?.mails ?? 0,
    };
  });
}
