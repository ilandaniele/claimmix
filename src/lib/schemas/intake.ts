/**
 * Zod schemas for intake simulation API.
 *
 * AC10: POST /api/intake/simulate — validated with SimulateIntakeSchema.
 * Returns 400 with Spanish error if validation fails.
 */

import { z } from "zod";
import { ClaimTypeSchema } from "@/lib/schemas/cases";

/** Valid scenario IDs (20 pre-seeded scenarios: s01–s20). */
export const SCENARIO_IDS = [
  "choque-01",
  "choque-02",
  "choque-03",
  "choque-04",
  "choque-05",
  "robo-01",
  "robo-02",
  "robo-03",
  "robo-04",
  "robo-05",
  "granizo-01",
  "granizo-02",
  "granizo-03",
  "granizo-04",
  "granizo-05",
  "incendio-01",
  "incendio-02",
  "incendio-03",
  "incendio-04",
  "incendio-05",
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

const ScenarioIdSchema = z.enum(SCENARIO_IDS, {
  errorMap: () => ({
    message: `ID de escenario inválido. Opciones válidas: ${SCENARIO_IDS.join(", ")}.`,
  }),
});

/**
 * POST /api/intake/simulate body.
 *
 * Two modes:
 *   1. scenario_id: use a pre-seeded scenario (trae su propio case_type)
 *   2. raw_text: ad-hoc text — el modelo clasifica el tipo, como con un mail
 *      real. `case_type` es opcional acá: si alguien lo manda igual (un
 *      caller avanzado) se guarda hasta que la extracción lo pise.
 */
export const SimulateIntakeSchema = z
  .object({
    scenario_id: ScenarioIdSchema.optional(),
    raw_text: z
      .string()
      .min(10, "El texto del siniestro debe tener al menos 10 caracteres.")
      .max(2_097_152, "El cuerpo del email excede el límite de 2 MB.")
      .optional(),
    case_type: ClaimTypeSchema.optional(),
  })
  .superRefine((data, ctx) => {
    const hasScenario = data.scenario_id !== undefined;
    const hasRaw = data.raw_text !== undefined;

    if (!hasScenario && !hasRaw) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Se requiere 'scenario_id' o 'raw_text'.",
        path: ["scenario_id"],
      });
    }
  });

export type SimulateIntake = z.infer<typeof SimulateIntakeSchema>;
