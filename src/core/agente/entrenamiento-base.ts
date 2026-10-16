/**
 * La base del agente: la política que escribió una persona en `entrenamiento/base/`,
 * leída desde el módulo que arma `pnpm entrenamiento:empaquetar`.
 *
 * Núcleo puro: sin entorno ni red, así que lo mismo lo lee el servidor, el ensayo
 * con tsx y la consola.
 *
 * Las secciones de modo `prompt` son el texto que corre en el prompt del paso. Las de
 * modo `sombra` describen una regla del código y no entran a ningún prompt de
 * producción: sólo sirven para medir al agente contra esa regla.
 */

import { ENTRENAMIENTO_BASE } from "./entrenamiento-base.generated";
import type {
  DecisionDeSombra,
  IdDeSeccion,
  PasoDelAgente,
  SeccionDeEntrenamiento,
} from "./entrenamiento-base.generated";

export { VERSION_DEL_ENTRENAMIENTO_BASE } from "./entrenamiento-base.generated";
export type {
  PasoDelAgente,
  ModoDeSeccion,
  DecisionDeSombra,
  IdDeSeccion,
  SeccionDeEntrenamiento,
} from "./entrenamiento-base.generated";

const TEXTO_POR_ID = new Map<IdDeSeccion, string>(ENTRENAMIENTO_BASE.map((s) => [s.id, s.texto]));

/** El texto de una sección. Un id que no existe es un error de código, no un dato. */
export function textoBase(id: IdDeSeccion): string {
  const texto = TEXTO_POR_ID.get(id);
  if (texto === undefined) throw new Error(`Sección de entrenamiento desconocida: ${id}`);
  return texto;
}

/** Las secciones de un paso, en el orden del módulo. */
export function seccionesDelPaso(paso: PasoDelAgente): readonly SeccionDeEntrenamiento[] {
  return ENTRENAMIENTO_BASE.filter((s) => s.paso === paso);
}

/** Las secciones de sombra, juntas; con `decisiones`, sólo las de esas decisiones. */
export function textoDeSombra(decisiones?: readonly DecisionDeSombra[]): string {
  return ENTRENAMIENTO_BASE.filter(
    (s) =>
      s.modo === "sombra" &&
      (!decisiones || (s.decision !== undefined && decisiones.includes(s.decision)))
  )
    .map((s) => s.texto)
    .join("\n\n");
}
