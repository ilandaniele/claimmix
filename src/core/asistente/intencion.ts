/**
 * Qué le pidió la persona al asistente, dicho en un vocabulario fijo.
 *
 * El modelo no elige texto libre: elige UNA herramienta de una lista cerrada
 * y sus argumentos, validados acá con zod `.strict()`. Una clave que el
 * modelo inventa —`sql`, `tenant_id`, un `herramienta` que no está en el
 * discriminated union— no pasa el parse y el llamador cae a `ninguna`. Ese
 * parse es la frontera entre lo que dijo el modelo y lo que corre contra la
 * base: nada de acá para abajo confía en el texto del modelo, sólo en esta
 * forma ya validada.
 *
 * Puro: sin `server-only`, sin tocar la base. `rangoDelPeriodo` y
 * `textoDelConteo` son las dos piezas determinísticas que arma la ruta, para
 * no depender de una segunda llamada al modelo en lo que ya se puede calcular.
 */

import { z } from "zod";
import {
  CLAVES_DE_ESTADO,
  type ClaveDeEstado,
} from "@/core/case/filtro-de-estado";
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

export const IntencionSchema = z.discriminatedUnion("herramienta", [
  z
    .object({
      herramienta: z.literal("contar_casos"),
      periodo: z.enum(PERIODOS),
      canal: z.enum(["email", "whatsapp"]).nullable(),
      situacion: z.enum(CLAVES_DE_ESTADO as [ClaveDeEstado, ...ClaveDeEstado[]]).nullable(),
      solo_reclamos: z.boolean(),
    })
    .strict(),
  z
    .object({
      herramienta: z.literal("buscar_caso"),
      nombre: z.string().trim().min(3).max(80).nullable(),
      numero: z
        .string()
        .regex(/^\d{1,12}$/)
        .nullable(),
    })
    .strict(),
  z.object({ herramienta: z.literal("ninguna") }).strict(),
]);

export type Intencion = z.infer<typeof IntencionSchema>;

/** Lo que devuelve `contarCasos`: sólo el total, ya filtrado. */
export interface ConteoDeCasos {
  total: number;
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

const NOMBRE_DEL_PERIODO: Record<Periodo, string> = {
  hoy: "hoy",
  ayer: "ayer",
  esta_semana: "esta semana",
  este_mes: "este mes",
  mes_pasado: "el mes pasado",
  este_anio: "este año",
  anio_pasado: "el año pasado",
  ultimos_30_dias: "en los últimos 30 días",
};

const NOMBRE_DEL_CANAL: Record<"email" | "whatsapp", string> = {
  email: "por email",
  whatsapp: "por WhatsApp",
};

const NOMBRE_DE_LA_SITUACION: Record<ClaveDeEstado, string> = {
  procesando: "procesando",
  esperando: "esperando al denunciante",
  confirmacion_pendiente: "con confirmación pendiente",
  escalado: "escalados",
  listo: "listos",
  cerrado: "cerrados",
};

/** El texto determinístico de un conteo. Sin segunda llamada al modelo. */
export function textoDelConteo(
  r: ConteoDeCasos,
  i: Intencion & { herramienta: "contar_casos" }
): string {
  const calificadores = [
    i.canal ? NOMBRE_DEL_CANAL[i.canal] : null,
    i.situacion ? NOMBRE_DE_LA_SITUACION[i.situacion] : null,
    i.solo_reclamos ? "que son reclamos" : null,
  ].filter((x): x is string => x !== null);

  const sufijo = calificadores.length > 0 ? `, ${calificadores.join(", ")}` : "";
  const sustantivo = r.total === 1 ? "caso" : "casos";
  return `Encontré ${r.total} ${sustantivo} ${NOMBRE_DEL_PERIODO[i.periodo]}${sufijo}.`;
}
