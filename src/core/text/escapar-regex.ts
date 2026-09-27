/**
 * Escapa los metacaracteres de regex para que un valor arbitrario entre en un
 * patrón como texto literal.
 *
 * Vivía repetida cinco veces (severity-classifier.ts y hydrate-fields.ts x4),
 * y una de las copias tenía la clase mal cerrada: `new RegExp` tiraba o
 * matcheaba mal ante un patrón con metacaracteres. Cinco copias no se pueden
 * mantener sincronizadas; una función sí.
 */
export function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
