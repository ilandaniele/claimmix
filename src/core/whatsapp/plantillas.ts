/**
 * Nombres de plantillas de WhatsApp aprobadas por Meta.
 *
 * Vive acá y no en el sender: lo lee también `conversacionDelCaso` (el
 * camino de lectura, para saber a quién atribuirle lo saliente), y ese
 * camino no debe arrastrar el envío real a Meta sólo por el nombre de una
 * plantilla.
 */

/** La única plantilla para que una persona responda por WhatsApp (P8). */
export const PLANTILLA_RESPUESTA_HUMANA = "wa_respuesta_humana";
