/**
 * Lo que se le dice a alguien cuyo adjunto pasó el tope de tamaño.
 *
 * El número sale del tope y no se copia a mano: si cambia, el aviso cambia con
 * él. Evita «rechazado», que el redactor prohíbe, y mantiene el mismo tono.
 *
 * Importa `firma`, que usa `node:zlib`: sólo desde el servidor, nunca desde un
 * componente de cliente.
 */

import { MAX_ATTACHMENT_SIZE_BYTES } from "@/core/adjuntos/firma";

export const ARCHIVO_QUE_NO_ENTRO =
  `Un archivo que nos mandaste pesa más de ${MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024)} MB ` +
  "y no lo pudimos recibir. ¿Nos lo podés mandar más liviano?";

/**
 * El texto con la frase al pie, cuando un archivo no entró. Una sola vez
 * aunque se aplique dos veces.
 */
export function conArchivoQueNoEntro(texto: string, noEntro: unknown): string {
  if (noEntro !== true || texto.includes(ARCHIVO_QUE_NO_ENTRO)) return texto;
  return `${texto}\n\n${ARCHIVO_QUE_NO_ENTRO}`;
}
