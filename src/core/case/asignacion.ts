/**
 * A quién le toca un caso según las reglas de la aseguradora (B9).
 *
 * Cada regla dice, para un tipo de siniestro y/o un turno, qué personas
 * reciben los casos. Vale la primera que coincide y tiene a alguien que edite;
 * una sin tipos ni turno es el comodín. Esta función sólo arma la lista en
 * orden de regla: el reparto por carga, y que la persona exista y edite, lo
 * decide la base en la misma sentencia que asigna.
 *
 * El turno se lee en hora argentina. Uno que cruza la medianoche (22:00 a
 * 06:00) pertenece al día en que empieza: a las 05:59 del martes rige el que
 * arrancó el lunes.
 *
 * Sólo del equipo: la asignación no sale al asegurado ni a las plantillas.
 */

import { z } from "zod";

import { ZONA_ARGENTINA } from "@/core/fecha/dia-argentino";
import { ClaimTypeSchema } from "@/lib/schemas/cases";

const Hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const TurnoSchema = z
  .object({
    /** 0 = domingo. */
    dias: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    desde: Hora,
    hasta: Hora,
  })
  .strict()
  .refine((t) => t.desde !== t.hasta, { message: "desde y hasta no pueden ser iguales" });
export type Turno = z.infer<typeof TurnoSchema>;

const ReglaSchema = z
  .object({
    tipos: z.array(ClaimTypeSchema).min(1).max(9).optional(),
    turno: TurnoSchema.optional(),
    personas: z.array(z.string().uuid()).min(1).max(50),
  })
  .strict();

export const ReglasSchema = z.object({ reglas: z.array(ReglaSchema).max(30) }).strict();
export type Reglas = z.infer<typeof ReglasSchema>;

const DIAS_DE_LA_SEMANA: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function momentoArgentino(ahora: Date): { dia: number; minutos: number } {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONA_ARGENTINA,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ahora);
  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
  return { dia: DIAS_DE_LA_SEMANA[p.weekday!] ?? 0, minutos: Number(p.hour) * 60 + Number(p.minute) };
}

const aMinutos = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

function enTurno(turno: Turno, ahora: Date): boolean {
  const { dia, minutos } = momentoArgentino(ahora);
  const desde = aMinutos(turno.desde);
  const hasta = aMinutos(turno.hasta);
  if (desde < hasta) return turno.dias.includes(dia) && minutos >= desde && minutos < hasta;
  return (turno.dias.includes(dia) && minutos >= desde) || (turno.dias.includes((dia + 6) % 7) && minutos < hasta);
}

export type Candidata = { persona: string; regla: number };

/**
 * Quiénes pueden recibir el caso: las personas de todas las reglas que
 * coinciden, cada una con la primera regla que la nombra (su posición va a la
 * auditoría), de la regla más alta a la más baja. Vacío si ninguna coincide.
 *
 * No corta en la primera regla: si su pool ya no tiene a nadie que edite, la
 * base sigue con la que viene y el caso no queda sin dueño.
 */
export function candidatasDeAsignacion(reglas: Reglas | null, e: { tipo: string | null; ahora: Date }): Candidata[] {
  const primera = new Map<string, number>();
  (reglas?.reglas ?? []).forEach((r, regla) => {
    const coincide =
      (!r.tipos || (e.tipo !== null && (r.tipos as string[]).includes(e.tipo))) && (!r.turno || enTurno(r.turno, e.ahora));
    if (coincide) for (const persona of r.personas) if (!primera.has(persona)) primera.set(persona, regla);
  });
  return [...primera].map(([persona, regla]) => ({ persona, regla }));
}
