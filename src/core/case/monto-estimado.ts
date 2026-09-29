/**
 * Cuánto cuesta más o menos un siniestro, para el equipo (B23).
 *
 * Es un rango orientativo por tipo y gravedad: la tabla propia de la
 * aseguradora si la cargó, y si no la de acá. Un presupuesto de taller leído y
 * razonable lo reemplaza por su total. Nunca se le dice al asegurado.
 */

import { z } from "zod";

import { ClaimTypeSchema, SeveritySchema, type ClaimType, type Severity } from "@/lib/schemas/cases";

export interface RangoDeMonto {
  minimo: number;
  maximo: number;
}

export type RangosDeMonto = Partial<Record<ClaimType, Partial<Record<Severity, RangoDeMonto>>>>;

export interface MontoEstimado extends RangoDeMonto {
  moneda: "ARS";
  origen: "tabla" | "presupuesto";
}

const M = 1_000_000;
const K = 1_000;

/**
 * Pesos de septiembre de 2026, orientativos: sirven para ordenar y marcar, no
 * para liquidar. La aseguradora los pisa con los suyos en Configuración, y los
 * tiene que validar el dueño antes de que alguien los lea como dato.
 */
export const MONTOS_POR_DEFECTO: RangosDeMonto = {
  choque: {
    low: { minimo: 400 * K, maximo: 1.5 * M },
    medium: { minimo: 1.5 * M, maximo: 5 * M },
    high: { minimo: 5 * M, maximo: 15 * M },
    critical: { minimo: 15 * M, maximo: 40 * M },
  },
  rc: {
    low: { minimo: 400 * K, maximo: 1.5 * M },
    medium: { minimo: 1.5 * M, maximo: 5 * M },
    high: { minimo: 5 * M, maximo: 20 * M },
    critical: { minimo: 20 * M, maximo: 80 * M },
  },
  robo: {
    low: { minimo: 300 * K, maximo: 1.5 * M },
    medium: { minimo: 1.5 * M, maximo: 6 * M },
    high: { minimo: 6 * M, maximo: 25 * M },
    critical: { minimo: 20 * M, maximo: 50 * M },
  },
  robo_contenido: {
    low: { minimo: 100 * K, maximo: 500 * K },
    medium: { minimo: 500 * K, maximo: 1.5 * M },
    high: { minimo: 1.5 * M, maximo: 4 * M },
    critical: { minimo: 4 * M, maximo: 8 * M },
  },
  granizo: {
    low: { minimo: 300 * K, maximo: 1 * M },
    medium: { minimo: 1 * M, maximo: 3.5 * M },
    high: { minimo: 3.5 * M, maximo: 9 * M },
    critical: { minimo: 9 * M, maximo: 25 * M },
  },
  incendio: {
    low: { minimo: 300 * K, maximo: 1.5 * M },
    medium: { minimo: 1.5 * M, maximo: 6 * M },
    high: { minimo: 6 * M, maximo: 20 * M },
    critical: { minimo: 20 * M, maximo: 45 * M },
  },
  cristales: {
    low: { minimo: 150 * K, maximo: 500 * K },
    medium: { minimo: 500 * K, maximo: 1.2 * M },
    high: { minimo: 1.2 * M, maximo: 2.5 * M },
    critical: { minimo: 2.5 * M, maximo: 5 * M },
  },
  accidente_personal: {
    low: { minimo: 500 * K, maximo: 2 * M },
    medium: { minimo: 2 * M, maximo: 8 * M },
    high: { minimo: 8 * M, maximo: 30 * M },
    critical: { minimo: 30 * M, maximo: 100 * M },
  },
};

/** Un importe en pesos leído o cargado: nunca negativo ni absurdo. */
export const ImporteSchema = z.number().finite().min(0).max(1e10);

export const RangoDeMontoSchema = z
  .object({ minimo: ImporteSchema, maximo: ImporteSchema })
  .strict()
  .refine((r) => r.minimo <= r.maximo, { message: "minimo > maximo" });

export const RangosDeMontoSchema = z.record(ClaimTypeSchema, z.record(SeveritySchema, RangoDeMontoSchema));

/** El rango de un tipo y una gravedad: el de la aseguradora, o el de la tabla. */
export function rangoPara(tipo: string | null, gravedad: string | null, rangosDelTenant: unknown): RangoDeMonto | null {
  const t = ClaimTypeSchema.safeParse(tipo);
  const g = SeveritySchema.safeParse(gravedad);
  if (!t.success || !g.success) return null;
  // Una tabla guardada que ya no valida no rompe la extracción: vale la de acá.
  const propios = RangosDeMontoSchema.safeParse(rangosDelTenant ?? {});
  const rangos = (propios.success ? propios.data : {}) as RangosDeMonto;
  return rangos[t.data]?.[g.data] ?? MONTOS_POR_DEFECTO[t.data]?.[g.data] ?? null;
}

export function estimarMonto(tipo: string | null, gravedad: string | null, rangosDelTenant: unknown): MontoEstimado | null {
  const rango = rangoPara(tipo, gravedad, rangosDelTenant);
  return rango ? { minimo: rango.minimo, maximo: rango.maximo, moneda: "ARS", origen: "tabla" } : null;
}

/**
 * El total del presupuesto reemplaza a la tabla sólo si está en pesos y cae
 * adentro del rango: uno fuera de rango se marca, no se toma como el monto.
 */
export function ajustarConPresupuesto(
  estimado: MontoEstimado | null,
  lectura: { total: number | null; moneda: string } | null
): MontoEstimado | null {
  if (!estimado || !lectura || lectura.moneda !== "ARS" || lectura.total === null) return estimado;
  if (lectura.total < estimado.minimo || lectura.total > estimado.maximo) return estimado;
  return { minimo: lectura.total, maximo: lectura.total, moneda: "ARS", origen: "presupuesto" };
}
