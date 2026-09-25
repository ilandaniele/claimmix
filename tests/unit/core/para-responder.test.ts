import { describe, it, expect } from "vitest";

import { ESTADOS_DE_ARRANQUE } from "@/core/case/estados-de-arranque";
import {
  ESTADOS_DEL_AGENTE_TERMINADO,
  ESTADOS_WHATSAPP_QUE_SUMAN_MENSAJES,
} from "@/core/case/para-responder";

const terminado = (s: string) => (ESTADOS_DEL_AGENTE_TERMINADO as readonly string[]).includes(s);
const sumaWhatsApp = (s: string) =>
  (ESTADOS_WHATSAPP_QUE_SUMAN_MENSAJES as readonly string[]).includes(s);

describe("«Para responder»", () => {
  it("un estado terminado nunca es uno desde el que el worker arranca", () => {
    for (const s of ESTADOS_DE_ARRANQUE) expect(terminado(s)).toBe(false);
  });

  // Donde el worker lee, el mensaje lo contesta el agente.
  it("WhatsApp suma a todo caso desde el que el worker arranca, menos procesando", () => {
    for (const s of ESTADOS_DE_ARRANQUE) expect(sumaWhatsApp(s)).toBe(s !== "procesando");
  });

  // En WhatsApp `procesando` sólo lo pone un operador que re-analiza: antes de
  // «Para responder» abría un caso nuevo, y sigue igual.
  it("procesando no suma el WhatsApp ni va a «Para responder»", () => {
    expect(sumaWhatsApp("procesando")).toBe(false);
    expect(terminado("procesando")).toBe(false);
  });

  // Escalado también llega por causas técnicas y la persona puede no haber
  // recibido nada: su mensaje abre un caso que el agente contesta.
  it("escalado no suma el WhatsApp, pero un correo en su hilo va a «Para responder»", () => {
    expect(sumaWhatsApp("escalado")).toBe(false);
    expect(terminado("escalado")).toBe(true);
  });

  it("error_core y requiere_especialista suman el WhatsApp y van a «Para responder»", () => {
    for (const s of ["error_core", "requiere_especialista"]) {
      expect(sumaWhatsApp(s)).toBe(true);
      expect(terminado(s)).toBe(true);
    }
  });

  it("cerrado, no_relevante y esperando no suman el WhatsApp ni van a «Para responder»", () => {
    for (const s of ["cerrado", "no_relevante", "esperando"]) {
      expect(sumaWhatsApp(s)).toBe(false);
      expect(terminado(s)).toBe(false);
    }
  });
});
