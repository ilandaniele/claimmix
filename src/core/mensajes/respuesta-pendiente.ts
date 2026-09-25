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

// Sin «por acá», porque en el cierre va detrás del aviso de que por este medio
// ya no sigue nadie. Y sin «la persona»: también va en los pedidos de datos, a
// mitad de la carga, donde nadie presentó a ninguna.
export const RESPUESTA_PENDIENTE =
  "Sobre lo que preguntás: todavía no podemos darte una respuesta, porque " +
  "nadie revisó tu caso aún. Te la damos cuando alguien del equipo lo revise.";

/**
 * El texto con la frase, cuando hubo pregunta. Una sola vez aunque se aplique
 * dos veces: el piso ya la trae y el redactor caído la volvía a pegar.
 */
export function conRespuestaPendiente(texto: string, pregunta: unknown): string {
  if (typeof pregunta !== "string" || !pregunta.trim()) return texto;
  if (texto.includes(RESPUESTA_PENDIENTE)) return texto;
  return `${texto}\n\n${RESPUESTA_PENDIENTE}`;
}
