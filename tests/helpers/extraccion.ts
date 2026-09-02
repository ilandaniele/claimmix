/**
 * Un `ExtractedClaim` de prueba, completo pero no necesariamente válido.
 *
 * Los fixtures armaban el objeto a mano y les faltaban catorce propiedades: el
 * esquema fue creciendo —`is_claim`, `confidence`, `field_confidences`,
 * `missing_fields`…— y los tests se quedaron con la forma vieja. No fallaban
 * porque `tsconfig.json` excluía `tests/**`, así que nadie los tipaba.
 *
 * Completar catorce campos a mano en cada fixture se vuelve a atrasar con el
 * próximo campo que se agregue, así que los defaults salen del esquema: se
 * parsea UNA vez el objeto mínimo y de ahí se cosechan. Un campo nuevo con
 * default aparece solo.
 *
 * Lo que NO hace es validar lo que se le pasa, y es a propósito. La primera
 * versión de esto llamaba a `.parse()` sobre el objeto entero y rompió dos
 * tests que existen justamente para eso: le pasan un `full_name` de 300
 * caracteres —más que el `.max(200)` del esquema— para comprobar que el worker
 * lo recorta. Un fixture que sólo puede llevar datos válidos no puede describir
 * a un modelo que devuelve cualquier cosa, que es la mitad de lo que estos
 * tests prueban.
 *
 * O sea: el esquema aporta la FORMA, el test aporta el CONTENIDO, incluso
 * cuando el contenido es el que no debería llegar nunca.
 */
import { ExtractedClaimSchema, type ExtractedClaim } from "@/lib/schemas/extracted-claim";
import type { z } from "zod";

/** Los defaults, cosechados del esquema una sola vez. */
const BASE: ExtractedClaim = ExtractedClaimSchema.parse({
  extraction_model: "fixture",
  fields: [],
  prompt_tokens: 0,
  completion_tokens: 0,
  cost_usd: 0,
});

export function extraccion(
  parcial: z.input<typeof ExtractedClaimSchema>
): ExtractedClaim {
  return { ...BASE, ...parcial } as ExtractedClaim;
}
