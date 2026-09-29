import { describe, expect, it } from "vitest";

import { conTranscripcion, ENCABEZADO_TRANSCRIPCION, PLACEHOLDER_AUDIO } from "@/core/adjuntos/transcripcion";

const TEXTO = "Choqué en la rotonda, el otro auto venía rápido.";

describe("conTranscripcion", () => {
  it("reemplaza el marcador del audio de WhatsApp por lo que se dijo", () => {
    const out = conTranscripcion(PLACEHOLDER_AUDIO, TEXTO);
    expect(out).toBe(`${ENCABEZADO_TRANSCRIPCION}\n${TEXTO}`);
    expect(out).not.toContain(PLACEHOLDER_AUDIO);
  });

  it("en un mail con texto propio lo agrega al final", () => {
    expect(conTranscripcion("Adjunto el audio.\n", TEXTO)).toBe(
      `Adjunto el audio.\n\n${ENCABEZADO_TRANSCRIPCION}\n${TEXTO}`
    );
  });

  it("es idempotente: el mismo texto dos veces no duplica el bloque", () => {
    const una = conTranscripcion(PLACEHOLDER_AUDIO, TEXTO);
    expect(conTranscripcion(una, TEXTO)).toBe(una);
  });

  it("otra nota del mismo mensaje agrega su bloque debajo", () => {
    const una = conTranscripcion(PLACEHOLDER_AUDIO, TEXTO);
    expect(conTranscripcion(una, "Y se fue.")).toBe(`${una}\n\n${ENCABEZADO_TRANSCRIPCION}\nY se fue.`);
  });

  it("un $& en lo que se dijo queda literal", () => {
    expect(conTranscripcion(PLACEHOLDER_AUDIO, "Pagué $& de más")).toBe(`${ENCABEZADO_TRANSCRIPCION}\nPagué $& de más`);
  });

  it("no cambia nada con una transcripción vacía", () => {
    expect(conTranscripcion(PLACEHOLDER_AUDIO, "   ")).toBe(PLACEHOLDER_AUDIO);
  });

  it("con un cuerpo nulo deja sólo el bloque", () => {
    expect(conTranscripcion(null, TEXTO)).toBe(`${ENCABEZADO_TRANSCRIPCION}\n${TEXTO}`);
  });
});
