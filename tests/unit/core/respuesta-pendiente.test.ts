import { describe, it, expect } from "vitest";
import {
  RESPUESTA_PENDIENTE,
  conRespuestaPendiente,
} from "@/core/mensajes/respuesta-pendiente";

const TEXTO = "Recibimos tu denuncia.";
const veces = (s: string) => s.split(RESPUESTA_PENDIENTE).length - 1;

describe("conRespuestaPendiente", () => {
  it("agrega la frase una vez, después del texto", () => {
    expect(conRespuestaPendiente(TEXTO, "¿Cuánto tarda?")).toBe(
      `${TEXTO}\n\n${RESPUESTA_PENDIENTE}`
    );
  });

  it("aplicarla dos veces es aplicarla una", () => {
    const una = conRespuestaPendiente(TEXTO, "¿Cuánto tarda?");
    expect(conRespuestaPendiente(una, "¿Cuánto tarda?")).toBe(una);
  });

  it("no la repite si el texto ya la trae", () => {
    const piso = `${TEXTO}\n\n${RESPUESTA_PENDIENTE}\n\nSaludos.`;
    const out = conRespuestaPendiente(piso, "¿Cuánto tarda?");
    expect(out).toBe(piso);
    expect(veces(out)).toBe(1);
  });

  it.each([null, undefined, "", "   ", 42])("sin pregunta (%j) deja el texto intacto", (p) => {
    expect(conRespuestaPendiente(TEXTO, p)).toBe(TEXTO);
  });
});
