/**
 * Lo que se le contesta a alguien que preguntó algo que todavía no se puede
 * contestar.
 *
 * No promete nada, porque nadie puede prometer nada antes de que una persona
 * mire la denuncia. Pero no hace de cuenta que la pregunta no existió, que es lo
 * que hacía el mail: el asegurado escribía «¿cuánto tarda esto? lo necesito para
 * trabajar» y recibía la misma lista de datos faltantes que la vuelta anterior,
 * palabra por palabra, sin una línea sobre lo que había preguntado.
 *
 * Estaba escrita y probada del lado de WhatsApp, en `compose-reply`, y el correo
 * no pasaba por ahí. Vive acá para que las dos la usen en vez de tener cada una
 * la suya, que es como se llega a dos productos con la misma cara.
 */

export const RESPUESTA_PENDIENTE =
  "Sobre lo que preguntás: todavía no podemos darte una respuesta, porque " +
  "nadie revisó tu caso aún. En cuanto un analista lo mire te avisamos por acá.";
