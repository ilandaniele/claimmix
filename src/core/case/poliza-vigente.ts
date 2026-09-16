/**
 * ¿Sigue en pie la póliza que encontramos, o ya no hay nada que evaluar?
 *
 * `verificar_poliza` tenía esta regla adentro, repetida cada vez que hacía
 * falta saber si una póliza cubre. Acá queda una sola vez, y de paso la
 * decisión de derivar sin preguntarle al modelo cuando la persona dio un
 * número, coincide con lo que encontramos, y esa póliza ya venció.
 */

import { normalizarNumeroPoliza } from "@/core/matching/normalizar";

/** Lo mínimo para decidir si una póliza está en pie. */
export interface Vigencia {
  status: string;
  endDate: string | null;
}
export interface PolizaConNumero extends Vigencia {
  policyNumber: string;
}

/** Misma regla que usaba `verificar_poliza`, ahora en un solo lugar. */
export function polizaEnVigencia(poliza: Vigencia, hoy: string): boolean {
  return poliza.status === "active" && (poliza.endDate === null || poliza.endDate >= hoy);
}

export interface PolizasDelCaso {
  /** Cuántas de las encontradas están en vigencia hoy. */
  vigentes: number;
  /** Cuántas no. */
  noVigentes: number;
  /** El día en que venció la primera no vigente, si tiene fecha. */
  vencioEl: string | null;
  /** Derivar sin deliberar: dio un número, coincidió, y no hay ninguna vigente. */
  derivar: boolean;
}

export function mirarPolizas(
  numeroQueDijo: string | null | undefined,
  encontradas: readonly PolizaConNumero[],
  hoy: string
): PolizasDelCaso {
  let vigentes = 0;
  let noVigentes = 0;
  let vencioEl: string | null = null;

  for (const poliza of encontradas) {
    if (polizaEnVigencia(poliza, hoy)) {
      vigentes++;
    } else {
      // Sólo la primera: es el dato que se muestra, no un conteo.
      if (noVigentes === 0) vencioEl = poliza.endDate;
      noVigentes++;
    }
  }

  const numeroDicho = numeroQueDijo?.trim();
  const coincide = !!numeroDicho
    ? encontradas.some(
        (p) => normalizarNumeroPoliza(p.policyNumber) === normalizarNumeroPoliza(numeroDicho)
      )
    : false;

  const derivar = !!numeroDicho && coincide && vigentes === 0 && noVigentes > 0;

  return { vigentes, noVigentes, vencioEl, derivar };
}
