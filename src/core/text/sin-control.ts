/**
 * Validación de texto de una línea que viene de afuera. La comparten el nombre
 * del formulario web, el de un ramo propio y los datos del padrón: una regla
 * para todos, en vez de una copia por ruta que se va desparejando.
 */

// Controles (saltos, NUL) y marcas de formato (inversión bidireccional, ancho cero): en una línea no significan nada bueno.
const MARCAS = /[\p{Cc}\p{Cf}]/u;

export const sinControl = (s: string): boolean => !MARCAS.test(s);

/** Además, sin `<` ni `>`: el texto viaja entre centinelas al prompt y termina en asuntos de mail. */
export const sinControlNiAngulares = (s: string): boolean => sinControl(s) && !/[<>]/.test(s);
