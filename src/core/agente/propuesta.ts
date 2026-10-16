/**
 * La propuesta para la base del agente: las reglas activas del cliente, en Markdown,
 * para que una persona las lea y decida si alguna se lleva a `entrenamiento/base/` con un PR.
 *
 * Núcleo puro. El repo es público y el texto lo escribió el cliente: sale con DNI,
 * pólizas, enlaces, mails y teléfonos tapados. Los nombres no se pueden tapar, y por eso
 * el archivo abre pidiendo que se lea entero antes de copiar nada.
 */

import { seccionesDelPaso, type PasoDelAgente } from "@/core/agente/entrenamiento-base";
import { PASOS_POR_TIPO, sinContactos, type ReglaDelEquipo } from "@/core/agente/indicaciones";
import { paraElPrompt } from "@/core/ai/para-el-prompt";

/** Estático: sin inquilino ni fecha en el nombre del archivo. */
export const NOMBRE_DE_LA_PROPUESTA = "propuesta-entrenamiento.md";

/** El mismo texto que `base.propuesta.aviso` en es-AR. */
export const AVISO_DE_LA_PROPUESTA =
  "El repo es público. Se tapan DNI, pólizas, enlaces, mails y teléfonos; los nombres no. Leelo entero antes de copiar algo a entrenamiento/base/.";

/** Los pasos del agente, en el orden en que corren. */
export const PASOS_DEL_AGENTE: readonly PasoDelAgente[] = ["extraccion", "decidir", "redactar"];

const limpio = (texto: string): string => sinContactos(paraElPrompt(texto));

type ReglaParaLaPropuesta = Pick<ReglaDelEquipo, "title" | "rule_text" | "rule_type">;

/** Las reglas, agrupadas por el último paso del agente que las lee. */
export function propuestaParaLaBase(reglas: readonly ReglaParaLaPropuesta[]): string {
  const partes = [
    "# Propuesta para la base del agente\n\nREVISAR ANTES DE SUBIR: texto escrito por el cliente\n\n" +
      AVISO_DE_LA_PROPUESTA,
  ];

  for (const paso of PASOS_DEL_AGENTE) {
    const delPaso = reglas.filter((r) => (PASOS_POR_TIPO[r.rule_type] ?? ["extraccion"]).at(-1) === paso);
    if (delPaso.length === 0) continue;

    const rutas = seccionesDelPaso(paso)
      .filter((s) => s.modo === "prompt")
      .map((s) => s.ruta)
      .join(", ");
    partes.push(`## ${paso} — secciones: ${rutas}`);
    for (const r of delPaso) {
      partes.push(`### ${limpio(r.title)} (${r.rule_type})\n\n${limpio(r.rule_text)}`);
    }
  }

  return partes.join("\n\n") + "\n";
}
