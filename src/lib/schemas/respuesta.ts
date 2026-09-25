/**
 * Zod schema for POST /api/cases/:id/responder.
 *
 * `.strict()` para que un `to` en el cuerpo no cambie a quién se le manda: el
 * destinatario sale siempre de `cases.email_thread_id`, nunca del pedido.
 */
import { z } from "zod";

export const RespuestaHumanaSchema = z
  .object({
    texto: z.string().trim().min(1).max(4096),
  })
  .strict();
