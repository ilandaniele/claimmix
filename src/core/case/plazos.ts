/**
 * Cuánto tiempo hay para cada cosa, según la Ley de Seguros (17.418) y según
 * la aseguradora (B10).
 *
 *   art. 46  el asegurado denuncia el siniestro dentro de los 3 días de
 *            conocerlo. Es un plazo DEL ASEGURADO: acá sólo señala cuántos días
 *            pasaron, no decide si llegó en término ni vence nada del analista.
 *   art. 56  el asegurador se pronuncia dentro de los 30 días de recibida la
 *            información completa. Lo anclamos a `listo_para_core`, que es
 *            cuando el agente da el caso por completo. Es una aproximación y
 *            la interfaz lo rotula como orientativo.
 *
 * Los días son corridos (CCyC art. 6: el día del hecho no se cuenta y los
 * plazos de días corren también los inhábiles), y el vencimiento cae al final
 * del día argentino, no del UTC. El servidor corre en UTC: contar en su zona
 * adelanta tres horas cada vencimiento.
 *
 * Todo esto es del equipo. No sale al asegurado, al prompt ni a las plantillas.
 */

import { z } from "zod";

import { dia } from "@/core/case/contradicciones";
import { ESTADOS_CERRADOS } from "@/core/case/fsm";
import { diaArgentino, medianocheArgentina } from "@/core/fecha/dia-argentino";
import { ClaimTypeSchema, type CaseStatus } from "@/lib/schemas/cases";
import { DIA_MS, DIAS_POR_VENCER } from "@/core/case/vencimiento-y-banda";

// Las cuentas del vencimiento que también usa el navegador viven sin zod en `vencimiento-y-banda.ts`.
export { DIAS_POR_VENCER, diasAlVencimiento, estadoDelVencimiento, type EstadoDelVencimiento } from "@/core/case/vencimiento-y-banda";

export const PLAZOS_LEGALES = {
  art46: { dias: 3 },
  art56: { dias: 30, ancla: "listo_para_core" },
} as const;

export const ANCLAS_DE_PLAZO = ["recibido", "listo_para_core", "en_liquidacion"] as const;
export type AnclaDePlazo = (typeof ANCLAS_DE_PLAZO)[number];

const CLAVES_RESERVADAS: readonly string[] = Object.keys(PLAZOS_LEGALES);

export const PlazoPropioSchema = z
  .object({
    clave: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    titulo: z.string().trim().min(1).max(80),
    dias: z.number().int().min(1).max(365),
    ancla: z.enum(ANCLAS_DE_PLAZO),
    tipos: z.array(ClaimTypeSchema).min(1).max(ClaimTypeSchema.options.length).optional(),
  })
  .strict();
export type PlazoPropio = z.infer<typeof PlazoPropioSchema>;

/** Los plazos propios de una aseguradora: la clave es única y no pisa a las de la ley. */
export const PlazosSchema = z.array(PlazoPropioSchema).max(20).superRefine((plazos, ctx) => {
  const vistas = new Set<string>();
  plazos.forEach((p, i) => {
    if (CLAVES_RESERVADAS.includes(p.clave) || vistas.has(p.clave)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "clave"], message: "clave repetida o reservada" });
    }
    vistas.add(p.clave);
  });
});

export type ProximoVencimiento =
  | { accion: "fijar"; vence: string; plazo: string }
  | { accion: "limpiar" }
  | { accion: "mantener" };

/**
 * El último instante del día argentino en que cae `desde` más `dias`, en ISO.
 * Es el milisegundo anterior a la medianoche siguiente, así que «vencido» es
 * `vence < ahora` sin ambigüedad en el borde.
 */
export function finDelDia(desde: Date, dias: number): string {
  const [anio, mes, d] = diaArgentino(desde).split("-").map(Number) as [number, number, number];
  return new Date(Date.parse(medianocheArgentina(anio, mes, d + dias + 1)) - 1).toISOString();
}

const anclaDe = (hacia: CaseStatus): AnclaDePlazo | null =>
  hacia === "listo_para_core" || hacia === "en_liquidacion" ? hacia : null;

const aplicaAlTipo = (p: PlazoPropio, tipo: string | null) => !p.tipos || (tipo !== null && (p.tipos as string[]).includes(tipo));

function masCorto(candidatos: { clave: string; dias: number }[]) {
  return candidatos.reduce<{ clave: string; dias: number } | null>(
    (mejor, c) => (mejor === null || c.dias < mejor.dias ? c : mejor),
    null
  );
}

/**
 * Qué le pasa al vencimiento del caso cuando entra a `hacia`.
 *
 * - Un estado terminal lo limpia: ya no hay nada que vencer.
 * - `listo_para_core` lo fija con el plazo más corto entre el art. 56 y los
 *   propios anclados ahí.
 * - `en_liquidacion` lo fija con el plazo propio más corto anclado ahí; sin
 *   uno, lo limpia, porque la aseguradora ya se pronunció y el art. 56 dejó de
 *   correr.
 * - Cualquier otro estado lo deja como está.
 *
 * El ancla `recibido` no pasa por acá: cuenta desde que entró el caso y la
 * fija la extracción con `vencimientoDeRecibido`.
 */
export function proximoVencimiento(e: {
  hacia: CaseStatus;
  tipo: string | null;
  ahora: Date;
  plazos: PlazoPropio[];
}): ProximoVencimiento {
  if (ESTADOS_CERRADOS.has(e.hacia)) return { accion: "limpiar" };
  const ancla = anclaDe(e.hacia);
  if (ancla === null) return { accion: "mantener" };
  const candidatos = [
    ...(ancla === "listo_para_core" ? [{ clave: "art56", dias: PLAZOS_LEGALES.art56.dias as number }] : []),
    ...e.plazos.filter((p) => p.ancla === ancla && aplicaAlTipo(p, e.tipo)).map((p) => ({ clave: p.clave, dias: p.dias })),
  ];
  const elegido = masCorto(candidatos);
  return elegido
    ? { accion: "fijar", vence: finDelDia(e.ahora, elegido.dias), plazo: elegido.clave }
    : { accion: "limpiar" };
}

/** El plazo propio más corto anclado en la entrada del caso, contado desde que se creó. */
export function vencimientoDeRecibido(e: {
  creadoEn: Date;
  tipo: string | null;
  plazos: PlazoPropio[];
}): { vence: string; plazo: string } | null {
  const elegido = masCorto(
    e.plazos.filter((p) => p.ancla === "recibido" && aplicaAlTipo(p, e.tipo)).map((p) => ({ clave: p.clave, dias: p.dias }))
  );
  return elegido ? { vence: finDelDia(e.creadoEn, elegido.dias), plazo: elegido.clave } : null;
}

export type FiltroDeVencimiento = "vencidos" | "por_vencer";

/**
 * El rango de `vence_en` de cada filtro de la bandeja: `desde` inclusive y
 * `hasta` exclusivo. Es la misma cuenta que `estadoDelVencimiento`, en una
 * forma que la base puede aplicar, y un test las compara sobre mil fechas.
 */
export function limitesDelFiltro(filtro: FiltroDeVencimiento, ahora: Date): { desde?: string; hasta: string } {
  return filtro === "vencidos"
    ? { hasta: ahora.toISOString() }
    : { desde: ahora.toISOString(), hasta: new Date(ahora.getTime() + DIAS_POR_VENCER * DIA_MS).toISOString() };
}

/**
 * Cuántos días pasaron entre el hecho y la denuncia (art. 46), como señal para
 * revisar y no como decisión: el plazo corre desde que el asegurado conoció el
 * siniestro y admite excepciones, y eso lo evalúa una persona.
 * `fechaHecho` es la que leyó el agente (`AAAA-MM-DD` o `dd/mm/aaaa`);
 * `recibidoEn`, el momento en que entró el caso. Sin una fecha que sirva, o con
 * el hecho después de la denuncia, no se opina.
 */
export function diasHastaLaDenuncia(
  fechaHecho: string | null | undefined,
  recibidoEn: string | Date | null | undefined
): { dias: number; superaArt46: boolean } | null {
  if (!recibidoEn) return null;
  const hecho = dia(fechaHecho);
  const recibido = dia(diaArgentino(new Date(recibidoEn)));
  if (hecho === null || recibido === null || recibido < hecho) return null;
  const dias = Math.round((recibido - hecho) / DIA_MS);
  return { dias, superaArt46: dias > PLAZOS_LEGALES.art46.dias };
}
