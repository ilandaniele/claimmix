/**
 * La transcripción de una nota de voz dentro del texto del mensaje.
 *
 * WhatsApp manda el audio sin texto y el webhook guarda este marcador en su
 * lugar. El worker, cuando transcribe, lo reemplaza por lo que se dijo; en un
 * mail, que ya tiene texto propio, lo agrega al final. Es idempotente: el mismo
 * texto dos veces no duplica el bloque, y otra nota del mismo mensaje agrega
 * el suyo debajo.
 */

export const PLACEHOLDER_AUDIO = "[Mensaje de audio adjunto]";
export const ENCABEZADO_TRANSCRIPCION = "Transcripción de nota de voz:";

export function conTranscripcion(body: string | null, texto: string): string {
  const actual = body ?? "";
  const limpio = texto.trim();
  const bloque = `${ENCABEZADO_TRANSCRIPCION}\n${limpio}`;
  if (!limpio || actual.includes(bloque)) return actual;
  if (actual.includes(PLACEHOLDER_AUDIO)) return actual.replace(PLACEHOLDER_AUDIO, () => bloque);
  return actual.trim() ? `${actual.trimEnd()}\n\n${bloque}` : bloque;
}
