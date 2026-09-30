/**
 * El checklist de trabajo de un caso, por tipo de siniestro (B11).
 *
 * Al llegar el caso a `listo_para_core` (o a `en_liquidacion` si no lo tenía)
 * se crea una fila por paso. Un paso con `auto` se tilda solo cuando el caso
 * entra a ese estado; los demás los tilda una persona. El título se copia al
 * crear el plan: si la aseguradora edita la plantilla, los casos que ya tienen
 * plan no cambian.
 *
 * Sólo del equipo: el plan no sale al asegurado ni a las plantillas.
 */

import { z } from "zod";

import { ClaimTypeSchema, type ClaimType } from "@/lib/schemas/cases";

export const ESTADOS_AUTOMATICOS = ["en_liquidacion", "pagado"] as const;
export type EstadoAutomatico = (typeof ESTADOS_AUTOMATICOS)[number];

const PasoSchema = z
  .object({
    clave: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    titulo: z.string().trim().min(1).max(120),
    auto: z.enum(ESTADOS_AUTOMATICOS).optional(),
  })
  .strict();
export type PasoDePlantilla = z.infer<typeof PasoSchema>;

const CLAVE_DE_TIPO = z.union([ClaimTypeSchema, z.literal("*")]);

export const PlanSchema = z
  .object({
    porTipo: z.record(CLAVE_DE_TIPO, z.array(PasoSchema).min(1).max(30)),
  })
  .strict()
  .superRefine((plan, ctx) => {
    for (const [tipo, pasos] of Object.entries(plan.porTipo)) {
      const vistas = new Set<string>();
      pasos.forEach((p, i) => {
        if (vistas.has(p.clave)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["porTipo", tipo, i, "clave"], message: "clave repetida" });
        }
        vistas.add(p.clave);
      });
    }
  });
export type Plan = z.infer<typeof PlanSchema>;

const ENTREGA: PasoDePlantilla = { clave: "entregar_a_aseguradora", titulo: "Entregar el caso a la aseguradora", auto: "en_liquidacion" };
const PAGO: PasoDePlantilla = { clave: "confirmar_pago", titulo: "Confirmar el pago al asegurado", auto: "pagado" };

export const PLAN_POR_DEFECTO: Plan = {
  porTipo: {
    "*": [
      { clave: "revisar_documentacion", titulo: "Revisar la documentación recibida" },
      { clave: "verificar_cobertura", titulo: "Verificar cobertura y vigencia de la póliza" },
      ENTREGA,
      PAGO,
    ],
    choque: [
      { clave: "revisar_documentacion", titulo: "Revisar la documentación recibida" },
      { clave: "verificar_cobertura", titulo: "Verificar cobertura y vigencia de la póliza" },
      { clave: "revisar_presupuesto", titulo: "Revisar el presupuesto del taller" },
      { clave: "definir_responsabilidad", titulo: "Definir la responsabilidad" },
      ENTREGA,
      PAGO,
    ],
    robo: [
      { clave: "revisar_documentacion", titulo: "Revisar la documentación recibida" },
      { clave: "verificar_denuncia_policial", titulo: "Verificar la denuncia policial" },
      { clave: "verificar_cobertura", titulo: "Verificar cobertura y vigencia de la póliza" },
      ENTREGA,
      PAGO,
    ],
    accidente_personal: [
      { clave: "revisar_documentacion", titulo: "Revisar la documentación recibida" },
      { clave: "pedir_certificado_medico", titulo: "Pedir el certificado médico" },
      { clave: "verificar_cobertura", titulo: "Verificar cobertura y vigencia de la póliza" },
      ENTREGA,
      PAGO,
    ],
  },
};

/** El título de fábrica de cada paso de la plantilla por defecto, por clave. */
const TITULOS_DE_FABRICA: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(PLAN_POR_DEFECTO.porTipo).flatMap((pasos) => pasos.map((p) => [p.clave, p.titulo]))
);

/**
 * La clave de diccionario con que se traduce el título de un paso, o null si
 * el título es de la aseguradora.
 *
 * El plan de fábrica se copia al caso en español, y esa copia es lo que queda
 * guardado. Un título que sigue idéntico al de fábrica se traduce al mostrarlo;
 * uno que la aseguradora escribió o cambió se muestra tal cual, porque no hay
 * de dónde traducirlo.
 */
export function claveDeTituloDeFabrica(paso: { clave: string; titulo: string }): `trabajo.paso.${string}` | null {
  return TITULOS_DE_FABRICA[paso.clave] === paso.titulo ? `trabajo.paso.${paso.clave}` : null;
}

/**
 * Los pasos para un tipo: el de la plantilla de la aseguradora, después su
 * comodín `*`, y si no cargó nada, los de acá por el mismo orden.
 */
export function planPara(tipo: ClaimType | string | null, plan: Plan | null): PasoDePlantilla[] {
  const buscar = (p: Plan) => (tipo !== null ? p.porTipo[tipo as ClaimType] : undefined) ?? p.porTipo["*"];
  return (plan ? buscar(plan) : undefined) ?? buscar(PLAN_POR_DEFECTO) ?? [];
}
