/**
 * Qué tan complicado es un caso, de 0 a 100, para que el equipo decida por
 * dónde empezar (B13).
 *
 * Es un promedio ponderado de cuatro señales que el agente ya sacó —gravedad,
 * riesgo de fraude, lesiones y monto estimado— más los campos propios que la
 * aseguradora quiera contar. Cada señal aporta entre 0 y 1 y se multiplica por
 * su peso; el puntaje es la suma sobre el total de pesos. Subir cualquier señal
 * nunca baja el puntaje, y con todos los pesos en cero da 0 en vez de NaN.
 *
 * Los pesos son de cada aseguradora; si no cargó ninguno rigen los de acá. Un
 * JSON guardado que ya no valida no rompe la extracción: vale el de acá.
 *
 * Sólo lo ve el equipo. No sale al asegurado, al prompt ni a las plantillas.
 */

import { z } from "zod";

import { ImporteSchema, type MontoEstimado } from "@/core/case/monto-estimado";
import { canonicalFieldKey } from "@/lib/labels/claim-fields";

const Peso = z.number().finite().min(0).max(100);

const CampoPonderadoSchema = z
  .object({
    clave: z.string().trim().min(1).max(60),
    valor: z.string().trim().min(1).max(120).optional(),
    puntos: Peso,
  })
  .strict();

export const PesosSchema = z
  .object({
    severidad: Peso,
    fraude: Peso,
    lesiones: Peso,
    monto: z
      .object({
        peso: Peso,
        umbral: z
          .object({ bajo: ImporteSchema, alto: ImporteSchema })
          .strict()
          .refine((u) => u.bajo < u.alto, { message: "bajo debe ser menor que alto" }),
      })
      .strict(),
    campos: z.array(CampoPonderadoSchema).max(20),
  })
  .strict();
export type Pesos = z.infer<typeof PesosSchema>;

const M = 1_000_000;

export const PESOS_POR_DEFECTO: Pesos = {
  severidad: 35,
  fraude: 25,
  lesiones: 25,
  monto: { peso: 15, umbral: { bajo: 0.5 * M, alto: 20 * M } },
  campos: [],
};

export interface Insumos {
  severidad: string | null;
  fraude: string | null;
  lesiones: string | null;
  monto: Pick<MontoEstimado, "maximo"> | null;
  /** Los campos propios del caso, por clave, con el valor tal cual quedó guardado. */
  campos: Record<string, string | null>;
}

const SEVERIDAD: Record<string, number> = { low: 0.2, medium: 0.5, high: 0.8, critical: 1 };
const FRAUDE: Record<string, number> = { low: 0.3, medium: 0.6, high: 1 };
const LESIONES: Record<string, number> = { minor: 0.4, severe: 1, fatal: 1 };

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Los pesos de la aseguradora, o los de acá si no cargó o no validan. */
export function pesosDe(guardados: unknown): Pesos {
  const leido = PesosSchema.safeParse(guardados);
  return leido.success ? leido.data : PESOS_POR_DEFECTO;
}

function aporteDelMonto(monto: Insumos["monto"], { bajo, alto }: Pesos["monto"]["umbral"]): number {
  if (!monto) return 0;
  return Math.min(1, Math.max(0, (monto.maximo - bajo) / (alto - bajo)));
}

const campoCoincide = (c: Pesos["campos"][number], campos: Insumos["campos"]) => {
  const guardado = campos[c.clave];
  if (guardado === null || guardado === undefined || guardado.trim() === "") return false;
  return c.valor === undefined || norm(guardado) === norm(c.valor);
};

export function puntajeDeComplejidad(insumos: Insumos, pesos: Pesos = PESOS_POR_DEFECTO): number {
  const partes: [number, number][] = [
    [pesos.severidad, SEVERIDAD[norm(insumos.severidad)] ?? 0],
    [pesos.fraude, FRAUDE[norm(insumos.fraude)] ?? 0],
    [pesos.lesiones, LESIONES[norm(insumos.lesiones)] ?? 0],
    [pesos.monto.peso, aporteDelMonto(insumos.monto, pesos.monto.umbral)],
    ...pesos.campos.map((c): [number, number] => [c.puntos, campoCoincide(c, insumos.campos) ? 1 : 0]),
  ];
  const total = partes.reduce((s, [w]) => s + w, 0);
  if (total === 0) return 0;
  const suma = partes.reduce((s, [w, c]) => s + w * c, 0);
  return Math.min(100, Math.max(0, Math.round((100 * suma) / total)));
}

/** Lo que hace falta de la fila del caso para puntuarlo. */
export interface FilaParaPuntaje {
  severity: string | null;
  fraud_risk_level: string | null;
  injury_severity: string | null;
  monto_estimado: Pick<MontoEstimado, "maximo"> | null;
}

/** Las claves de campo que los pesos de la aseguradora cuentan, sin repetir. */
export function clavesPonderadas(guardados: unknown): string[] {
  return [...new Set(pesosDe(guardados).campos.map((c) => c.clave))];
}

/**
 * Los valores guardados de los campos que los pesos cuentan, con la clave que
 * los pesos usan; el que no está guardado va en null.
 */
export function camposDelPuntaje(
  guardados: unknown,
  campos: { field_key: string; field_value: string | null }[]
): Record<string, string | null> {
  const porClave = new Map(campos.map((f) => [f.field_key, f.field_value]));
  return Object.fromEntries(clavesPonderadas(guardados).map((k) => [k, porClave.get(canonicalFieldKey(k)) ?? null]));
}

/**
 * El puntaje de un caso a partir de su fila y de los campos que le dieron.
 * Los tres caminos que lo recalculan —la extracción, una confirmación y un
 * presupuesto leído— pasan por acá para no contar distinto.
 */
export function puntajeDelCaso(
  fila: FilaParaPuntaje,
  campos: Record<string, string | null | undefined>,
  guardados: unknown
): number {
  const propios: Record<string, string | null> = {};
  for (const [clave, valor] of Object.entries(campos)) propios[clave] = valor ?? null;
  return puntajeDeComplejidad(
    {
      severidad: fila.severity,
      fraude: fila.fraud_risk_level,
      lesiones: fila.injury_severity,
      monto: fila.monto_estimado,
      campos: propios,
    },
    pesosDe(guardados)
  );
}

// Las bandas que también usa el navegador viven sin zod en `vencimiento-y-banda.ts`.
export { RANGOS, bandaDe, type BandaDeComplejidad } from "@/core/case/vencimiento-y-banda";
