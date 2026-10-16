/**
 * Una nota de voz que no se pudo transcribir no sube la gravedad.
 *
 * El modelo sólo ve «[Mensaje de audio adjunto]» y a veces lo calificaba
 * «high»: el caso se derivaba a un especialista por un audio mudo y lo que
 * llegaba después ya no se leía.
 */

import { describe, it, expect } from "vitest";
import { gravedadSinHechosNuevos } from "@/server/ai/severity-classifier";
import { PLACEHOLDER_AUDIO } from "@/core/adjuntos/transcripcion";

describe("gravedadSinHechosNuevos", () => {
  it("con un audio sin transcribir no pasa de la gravedad que el caso ya tenía", () => {
    expect(gravedadSinHechosNuevos("high", "medium", PLACEHOLDER_AUDIO)).toBe("medium");
    expect(gravedadSinHechosNuevos("critical", "low", ` ${PLACEHOLDER_AUDIO}\n`)).toBe("low");
  });

  it("puede bajar o quedar igual", () => {
    expect(gravedadSinHechosNuevos("low", "high", PLACEHOLDER_AUDIO)).toBe("low");
    expect(gravedadSinHechosNuevos("high", "high", PLACEHOLDER_AUDIO)).toBe("high");
  });

  it("con texto, o con el audio ya transcripto, manda el modelo", () => {
    expect(gravedadSinHechosNuevos("high", "medium", "se prendió fuego el auto")).toBe("high");
    expect(
      gravedadSinHechosNuevos("high", "medium", `${PLACEHOLDER_AUDIO} y además hay un herido`)
    ).toBe("high");
  });

  it("sin gravedad previa válida o sin la del modelo, no toca nada", () => {
    expect(gravedadSinHechosNuevos("high", null, PLACEHOLDER_AUDIO)).toBe("high");
    expect(gravedadSinHechosNuevos("high", "grave", PLACEHOLDER_AUDIO)).toBe("high");
    expect(gravedadSinHechosNuevos(null, "medium", PLACEHOLDER_AUDIO)).toBeNull();
  });
});
