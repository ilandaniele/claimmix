/**
 * ¿Está prendido el número de WhatsApp por código?
 *
 * Es la bandera `ALTA_NUMERO_AUTOMATICO`, apagada por omisión: sin ella nada
 * llama a Graph y la interfaz sigue diciendo «lo conectamos nosotros». Vive sola
 * y sin imports a propósito: la leen la bandeja, /alta y /configuracion, y sus
 * tests no tienen que mockear `server-only` ni arrastrar la cadena de la base.
 */
export function numeroAutomatico(): boolean {
  return process.env.ALTA_NUMERO_AUTOMATICO === "1";
}
