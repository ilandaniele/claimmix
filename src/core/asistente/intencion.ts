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
 * Puro: sin `server-only`, sin tocar la base. `textoDelConteo` es la pieza
 * determinística que arma la ruta, para no depender de una segunda llamada al
 * modelo en lo que ya se puede calcular (el rango del período vive en
 * `@/core/metricas/periodo`).
 */

import { z } from "zod";
import {
  CLAVES_DE_ESTADO,
  type ClaveDeEstado,
} from "@/core/case/filtro-de-estado";
import { PERIODOS, type Periodo } from "@/core/metricas/periodo";

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
      // Los 8 caracteres hex del número de caso ("SIN-XXXX-XXXX"), sin guiones.
      codigo: z.string().regex(/^[0-9a-f]{8}$/i).nullable(),
    })
    .strict(),
  z.object({ herramienta: z.literal("ninguna") }).strict(),
]);

export type Intencion = z.infer<typeof IntencionSchema>;

/** Lo que devuelve `contarCasos`: sólo el total, ya filtrado. */
export interface ConteoDeCasos {
  total: number;
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
