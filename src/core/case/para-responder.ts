/**
 * Cuándo lo que llega a un caso lo contesta una persona y no el agente.
 *
 * Cuando el agente ya terminó con el caso, un mensaje nuevo de la persona no lo
 * lee el worker: el ingreso marca el caso en «Para responder» y lo contesta
 * alguien (`marcarParaResponder`, en `@/server/cases/para-responder`).
 *
 * Cada canal llega distinto:
 *
 * - WhatsApp suma el mensaje al caso sólo si está en
 *   `ESTADOS_WHATSAPP_QUE_SUMAN_MENSAJES`; si no, abre un caso nuevo que el
 *   agente contesta. `procesando`, `cerrado`, `no_relevante`, `esperando` y
 *   `escalado` abren uno nuevo.
 * - En el correo el hilo es la conversación: la respuesta cae en el caso esté
 *   como esté. Va a «Para responder» si el caso está en
 *   `ESTADOS_DEL_AGENTE_TERMINADO`; `no_relevante` se reabre
 *   (`reabrir-no-relevante`), y `cerrado` o `esperando` quedan sólo en la
 *   auditoría, como antes.
 */
import type { CaseStatus } from "@/lib/schemas/cases";

// El agente ya le contestó a la persona: la dejó lista, la mandó al core o le
// dijo que la toma un especialista. `error_core` viene después de
// `listo_para_core`, así que también.
const TERMINADOS_CON_RESPUESTA = [
  "listo",
  "listo_para_core",
  "enviado_a_core",
  "error_core",
  "requiere_especialista",
] as const satisfies readonly CaseStatus[];

export const ESTADOS_DEL_AGENTE_TERMINADO = [
  ...TERMINADOS_CON_RESPUESTA,
  "escalado",
] as const satisfies readonly CaseStatus[];

// Donde la conversación sigue con el agente, más los terminados con respuesta.
//
// `procesando` no: en WhatsApp sólo lo pone un re-análisis o un reproceso de un
// operador, y sumarle mensajes sería cambiar a dónde van sin que nadie lo pidiera.
// `escalado` tampoco: también llega por causas técnicas —presupuesto agotado, un
// error de Gemini, un caso trabado— y la persona puede no haber recibido nada.
// En los dos, el mensaje siguiente abre un caso nuevo que el agente sí contesta.
export const ESTADOS_WHATSAPP_QUE_SUMAN_MENSAJES = [
  "recibido",
  "info_faltante",
  "confirmacion_pendiente",
  ...TERMINADOS_CON_RESPUESTA,
] as const satisfies readonly CaseStatus[];
